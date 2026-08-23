const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateHero, planFallbackSkills, testModelConnection } = require('./hero-generator.cjs');

const root = process.cwd();
const port = Number(process.env.WEB_AI_GAME_PORT || 8000);
const host = process.env.WEB_AI_GAME_HOST || '0.0.0.0';
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg'
};

let rooms = {};
const roomClients = new Set();
const generationJobs = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeRoom(room, roomCode) {
  if (!room || typeof room !== 'object' || Array.isArray(room)) return null;
  const nextRoom = clone(room);
  nextRoom.roomCode = roomCode || nextRoom.roomCode;
  if (!nextRoom.roomCode) return null;
  if (!nextRoom.createdAt) nextRoom.createdAt = Date.now();
  if (typeof nextRoom.updatedAt !== 'number') nextRoom.updatedAt = nextRoom.createdAt;
  if (typeof nextRoom.revision !== 'number') nextRoom.revision = 0;
  if (typeof nextRoom.schemaVersion !== 'number') nextRoom.schemaVersion = 1;
  return nextRoom;
}

function normalizeRooms(inputRooms) {
  const nextRooms = {};
  Object.entries(inputRooms || {}).forEach(([roomCode, room]) => {
    const nextRoom = normalizeRoom(room, roomCode);
    if (nextRoom) nextRooms[roomCode] = nextRoom;
  });
  return nextRooms;
}

// 对外广播/响应时隐藏房主填写的 API Key，服务器内存里保留完整配置用于 AI 生成。
function sanitizeRoomsForClient(sourceRooms) {
  const nextRooms = clone(sourceRooms || {});
  Object.values(nextRooms).forEach((room) => {
    if (room?.aiConfig) {
      const safeConfig = { ...room.aiConfig };
      delete safeConfig.apiKey;
      if (Object.keys(safeConfig).length) room.aiConfig = safeConfig;
      else delete room.aiConfig;
    }
  });
  return nextRooms;
}

rooms = normalizeRooms(rooms);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 3 * 1024 * 1024) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function broadcastRooms() {
  const payload = `event: rooms\ndata: ${JSON.stringify({ rooms: sanitizeRoomsForClient(rooms), updatedAt: Date.now() })}\n\n`;
  roomClients.forEach((client) => {
    try {
      client.write(payload);
    } catch {
      roomClients.delete(client);
    }
  });
}

function applyRoomSnapshot(nextRooms) {
  const currentRooms = rooms;
  const mergedRooms = normalizeRooms(nextRooms);
  Object.entries(mergedRooms).forEach(([roomCode, room]) => {
    preserveAiConfig(currentRooms[roomCode], room);
  });
  rooms = mergedRooms;
  broadcastRooms();
  return { ok: true, rooms, updatedAt: Date.now() };
}

function gameMutationAllowed(currentRoom, nextRoom, actorPlayerId) {
  const previousGame = currentRoom?.game;
  const nextGame = nextRoom?.game;
  if (JSON.stringify(previousGame || null) === JSON.stringify(nextGame || null)) return true;

  const players = currentRoom?.players || [];
  const actor = players.find((player) => player.id === actorPlayerId);
  if (!actor) return false;

  if (!previousGame) {
    const hostId = players.find((player) => player.role === 'host')?.id || players[0]?.id;
    return actorPlayerId === hostId;
  }

  const expectedPlayerId = previousGame.phase === 'RESPONSE'
    ? previousGame.pendingAttack?.targetId
    : previousGame.phase === 'DYING'
      ? previousGame.pendingRescue?.targetId
      : previousGame.phase === 'DRAWING'
        ? previousGame.drawPlayerId
        : previousGame.currentPlayerId;
  const expectedIsRealPlayer = players.some((player) => player.id === expectedPlayerId);
  if (expectedIsRealPlayer) return actorPlayerId === expectedPlayerId;

  const hostId = players.find((player) => player.role === 'host')?.id || players[0]?.id;
  return actorPlayerId === hostId;
}

function applyRoomChanges(changes, knownRevisions = {}, actorPlayerId = null) {
  const currentRooms = rooms;
  const nextRooms = clone(currentRooms);
  const conflicts = [];
  const now = Date.now();

  Object.entries(changes || {}).forEach(([roomCode, roomPatch]) => {
    const currentRoom = currentRooms[roomCode] || null;
    const expectedRevision = typeof knownRevisions[roomCode] === 'number'
      ? knownRevisions[roomCode]
      : (currentRoom?.revision ?? 0);
    const currentRevision = currentRoom?.revision ?? 0;

    if (currentRevision !== expectedRevision) {
      conflicts.push({ roomCode, expectedRevision, currentRevision });
      return;
    }

    if (roomPatch === null) {
      delete nextRooms[roomCode];
      return;
    }

    const normalized = normalizeRoom(roomPatch, roomCode);
    if (!normalized) {
      conflicts.push({ roomCode, reason: 'invalid-room' });
      return;
    }
    preserveAiConfig(currentRoom, normalized);
    if (!gameMutationAllowed(currentRoom, normalized, actorPlayerId)) {
      conflicts.push({ roomCode, reason: 'game-action-not-authorized' });
      return;
    }

    normalized.revision = currentRevision + 1;
    normalized.updatedAt = now;
    if (!normalized.createdAt) normalized.createdAt = currentRoom?.createdAt || now;
    nextRooms[roomCode] = normalized;
  });

  if (conflicts.length) {
    return { ok: false, conflicts, rooms: currentRooms, updatedAt: Date.now() };
  }

  rooms = normalizeRooms(nextRooms);
  broadcastRooms();
  return { ok: true, rooms, updatedAt: Date.now() };
}

function preserveAiConfig(currentRoom, nextRoom) {
  const currentAi = currentRoom?.aiConfig;
  const nextAi = nextRoom?.aiConfig;
  if (!currentAi && !nextAi) return;
  nextRoom.aiConfig = {
    provider: nextAi?.provider || currentAi?.provider,
    model: nextAi?.model || currentAi?.model,
    baseUrl: nextAi?.baseUrl || currentAi?.baseUrl,
    apiKey: nextAi?.apiKey || currentAi?.apiKey
  };
  if (!nextRoom.aiConfig.provider && !nextRoom.aiConfig.apiKey) delete nextRoom.aiConfig;
}

function cleanupRooms() {
  const expirationTime = Date.now() - (24 * 60 * 60 * 1000);
  let changed = false;

  Object.keys(rooms).forEach((roomCode) => {
    if (!rooms[roomCode]?.createdAt || rooms[roomCode].createdAt < expirationTime) {
      delete rooms[roomCode];
      changed = true;
    }
  });

  if (changed) broadcastRooms();
}

function allPlayersSubmitted(room) {
  return Boolean(room?.players?.length) && room.players.every((player) => {
    const cards = room.customizations?.[player.id]?.cards;
    return Array.isArray(cards) && cards.length === 1 && cards[0]?.name && cards[0]?.description;
  });
}

function touchRoom(room) {
  room.revision = (room.revision || 0) + 1;
  room.updatedAt = Date.now();
}

async function generateRoomHeroes(roomCode) {
  if (generationJobs.has(roomCode)) return generationJobs.get(roomCode);
  const job = (async () => {
    const room = rooms[roomCode];
    if (!room || !allPlayersSubmitted(room)) return;
    room.phase = 'GENERATING';
    room.heroGeneration = {
      status: 'RUNNING',
      startedAt: Date.now(),
      completedCount: 0,
      totalCount: room.players.length
    };
    touchRoom(room);
    broadcastRooms();

    const generatedEntries = [];
    const blockedSkillIds = new Set();
    const usedSkillNames = new Set();
    const llmEnabled = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
    const cardsById = {};
    room.players.forEach((player) => {
      cardsById[player.id] = room.customizations[player.id].cards[0];
    });
    const skillPlan = llmEnabled
      ? null
      : planFallbackSkills(room.players.map((player) => cardsById[player.id]));
    const plannedIds = new Set();
    if (skillPlan) {
      room.players.forEach((player, index) => {
        const current = skillPlan.get(index);
        if (current?.primaryId) plannedIds.add(current.primaryId);
        if (current?.secondaryId) plannedIds.add(current.secondaryId);
      });
    }
    for (let index = 0; index < room.players.length; index += 1) {
      const player = room.players[index];
      const card = cardsById[player.id];
      const planned = skillPlan?.get(index);
      const planBlocked = new Set(plannedIds);
      if (planned?.primaryId) planBlocked.delete(planned.primaryId);
      if (planned?.secondaryId) planBlocked.delete(planned.secondaryId);
      const aiConfig = room.aiConfig || {};
      const hero = await generateHero(card, {
        blockedSkillIds: Array.from(planBlocked),
        usedNames: Array.from(usedSkillNames),
        preferredPrimarySkillId: planned?.primaryId || null,
        preferredSecondarySkillId: planned?.secondaryId || null,
        provider: aiConfig.provider,
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        baseUrl: aiConfig.baseUrl
      });
      generatedEntries.push([player.id, hero]);
      if (!skillPlan) {
        [hero.primarySkill?.templateId, hero.secondarySkill?.templateId].filter(Boolean).forEach((id) => blockedSkillIds.add(id));
      }
      [hero.primarySkill?.name, hero.secondarySkill?.name].filter(Boolean).forEach((skillName) => usedSkillNames.add(skillName));
      const currentRoom = rooms[roomCode];
      if (currentRoom?.heroGeneration?.status === 'RUNNING') {
        currentRoom.heroGeneration.completedCount += 1;
        currentRoom.updatedAt = Date.now();
        broadcastRooms();
      }
    }

    const currentRoom = rooms[roomCode];
    if (!currentRoom) return;
    currentRoom.generatedHeroes = Object.fromEntries(generatedEntries);
    currentRoom.heroGeneration = {
      ...currentRoom.heroGeneration,
      status: 'READY',
      completedCount: generatedEntries.length,
      completedAt: Date.now(),
      source: generatedEntries.some(([, hero]) => hero.generationSource !== 'fallback')
        ? generatedEntries.find(([, hero]) => hero.generationSource !== 'fallback')[1].generationSource
        : 'fallback'
    };
    currentRoom.phase = 'PLAYING';
    currentRoom.startedAt = currentRoom.startedAt || Date.now();
    touchRoom(currentRoom);
    broadcastRooms();
  })().catch((error) => {
    const room = rooms[roomCode];
    if (room) {
      room.heroGeneration = {
        ...(room.heroGeneration || {}),
        status: 'FAILED',
        message: '英雄生成失败，请重新提交。'
      };
      room.phase = 'CUSTOMIZING';
      touchRoom(room);
      broadcastRooms();
    }
    console.error(`Room ${roomCode} hero generation failed:`, error);
  }).finally(() => generationJobs.delete(roomCode));
  generationJobs.set(roomCode, job);
  return job;
}

async function handleApi(request, response, requestPath) {
  if (request.method === 'GET' && requestPath === '/api/rooms') {
    cleanupRooms();
    sendJson(response, 200, { rooms: sanitizeRoomsForClient(rooms), updatedAt: Date.now() });
    return true;
  }

  if (request.method === 'POST' && requestPath === '/api/ai/test') {
    try {
      const payload = await readJson(request);
      const result = await testModelConnection({
        provider: payload?.provider,
        apiKey: payload?.apiKey,
        model: payload?.model,
        baseUrl: payload?.baseUrl
      });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, { ok: false, message: error?.message || 'AI 连接测试失败。' });
    }
    return true;
  }

  if (request.method === 'PUT' && requestPath === '/api/rooms') {
    try {
      const payload = await readJson(request);
      cleanupRooms();
      if (payload && typeof payload.changes === 'object' && payload.changes && !Array.isArray(payload.changes)) {
        const result = applyRoomChanges(payload.changes, payload.knownRevisions || {}, payload.actorPlayerId || null);
        sendJson(response, result.ok ? 200 : 409, result);
        if (!result.ok) broadcastRooms();
      } else if (payload && typeof payload.rooms === 'object' && !Array.isArray(payload.rooms)) {
        const result = applyRoomSnapshot(payload.rooms);
        sendJson(response, 200, result);
      } else {
        sendJson(response, 400, { ok: false, message: 'Invalid rooms payload' });
      }
    } catch {
      sendJson(response, 400, { ok: false, message: 'Invalid JSON payload' });
    }
    return true;
  }

  const customizationMatch = requestPath.match(/^\/api\/rooms\/(\d{6})\/customizations$/);
  if (request.method === 'POST' && customizationMatch) {
    try {
      const roomCode = customizationMatch[1];
      const payload = await readJson(request);
      const room = rooms[roomCode];
      const player = room?.players?.find((item) => item.id === payload.playerId);
      const inputCard = Array.isArray(payload.cards) ? payload.cards[0] : null;
      const name = String(inputCard?.name || '').trim().slice(0, 16);
      const description = String(inputCard?.description || '').trim().slice(0, 120);
      if (!room) {
        sendJson(response, 404, { ok: false, message: '房间不存在或已失效。' });
        return true;
      }
      if (!player) {
        sendJson(response, 403, { ok: false, message: '玩家不属于该房间。' });
        return true;
      }
      if (!name || !description) {
        sendJson(response, 400, { ok: false, message: '英雄名称和描述不能为空。' });
        return true;
      }
      if (room.phase === 'PLAYING' && room.heroGeneration?.status === 'READY') {
        sendJson(response, 409, { ok: false, message: '本局英雄已经生成。' });
        return true;
      }

      room.customizations = room.customizations || {};
      room.customizations[player.id] = {
        playerId: player.id,
        nickname: player.nickname,
        submittedAt: Date.now(),
        cards: [{ name, description }]
      };
      delete room.generatedHeroes;
      room.heroGeneration = { status: 'WAITING' };
      touchRoom(room);
      broadcastRooms();
      if (allPlayersSubmitted(room)) void generateRoomHeroes(roomCode);
      sendJson(response, 202, { ok: true, room, generationStarted: allPlayersSubmitted(room) });
    } catch {
      sendJson(response, 400, { ok: false, message: '无法读取英雄定制数据。' });
    }
    return true;
  }

  if (request.method === 'GET' && requestPath === '/api/rooms/events') {
    cleanupRooms();
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    response.write(`event: rooms\ndata: ${JSON.stringify({ rooms: sanitizeRoomsForClient(rooms), updatedAt: Date.now() })}\n\n`);
    roomClients.add(response);
    request.on('close', () => roomClients.delete(response));
    return true;
  }

  return false;
}

function serveFile(response, requestPath) {
  const relativePath = requestPath === '/' ? 'home.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(root, relativePath);

  if (!filePath.startsWith(root + path.sep)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, max-age=0'
    });
    response.end(data);
  });
}

http.createServer(async (request, response) => {
  const requestPath = decodeURIComponent(request.url.split('?')[0]);

  if (requestPath.startsWith('/api/')) {
    const handled = await handleApi(request, response, requestPath);
    if (!handled) sendJson(response, 404, { ok: false, message: 'API route not found' });
    return;
  }

  serveFile(response, requestPath);
}).listen(port, host, () => {
  console.log(`天下英雄杀 prototype server: http://127.0.0.1:${port}/`);
  console.log(`Room sync API enabled: http://127.0.0.1:${port}/api/rooms`);
  const llmProvider = process.env.LLM_PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai');
  const llmEnabled = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
  const llmModel = llmProvider === 'deepseek' ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat') : (process.env.OPENAI_MODEL || 'gpt-4.1-mini');
  console.log(`AI hero generation: ${llmEnabled ? `server env fallback ${llmProvider} (${llmModel})` : 'no server key'} — 房主可在创建房间时选择 DeepSeek/通义千问并填写自己的 API Key，未配置时使用本地兜底生成。`);
});
