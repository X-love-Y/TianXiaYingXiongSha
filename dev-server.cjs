const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateHero, planFallbackSkills, testModelConnection } = require('./hero-generator.cjs');
const { createSession } = require('./server-game.cjs');

const root = process.cwd();
const port = Number(process.env.WEB_AI_GAME_PORT || 8000);
const host = process.env.WEB_AI_GAME_HOST || '0.0.0.0';
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const PUBLIC_EXTENSIONS = new Set(['.html', '.css', '.js', '.png', '.mp3', '.svg', '.ico']);

let rooms = {};
const roomClients = new Set();
const generationJobs = new Map();
const roomSessions = new Map();

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

// 高频房间变更（对局内每步、生成进度等）在极短时间内会触发大量 broadcast，
// 在低配服务器上会向所有客户端推送一串完整房间快照，导致对局界面高频重绘/闪烁。
// 这里用 40ms 去抖合并，把同一小段时间内的变更合并为一次推送。
let broadcastTimer = null;
let broadcastDirty = false;
function scheduleBroadcast() {
  broadcastDirty = true;
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    if (broadcastDirty) {
      broadcastDirty = false;
      broadcastRooms();
    }
  }, 40);
}

function applyRoomSnapshot(nextRooms) {
  const currentRooms = rooms;
  const mergedRooms = normalizeRooms(nextRooms);
  Object.entries(mergedRooms).forEach(([roomCode, room]) => {
    preserveAiConfig(currentRooms[roomCode], room);
  });
  rooms = mergedRooms;
  scheduleBroadcast();
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
    ? (previousGame.pendingAttack?.targetId || previousGame.pendingSpell?.currentTargetId)
    : previousGame.phase === 'DYING'
      ? previousGame.pendingRescue?.targetId
      : previousGame.phase === 'DRAWING'
        ? previousGame.drawPlayerId
        : previousGame.currentPlayerId;
  const expectedIsRealPlayer = players.some((player) => player.id === expectedPlayerId);
  if (expectedIsRealPlayer) {
    if (actorPlayerId === expectedPlayerId) return true;
    // 期望玩家的响应/濒死/摸牌/出牌截止时间已过时，允许房主代为推进，
    // 避免真实玩家掉线或关闭页面后整局永久卡死。
    const now = Date.now();
    const deadline = previousGame.phase === 'RESPONSE' || previousGame.phase === 'DYING'
      ? previousGame.responseDeadline
      : previousGame.phase === 'DRAWING'
        ? previousGame.drawDeadline
        : previousGame.turnDeadline;
    if (deadline && now > deadline) {
      const hostId = players.find((player) => player.role === 'host')?.id || players[0]?.id;
      return actorPlayerId === hostId;
    }
    return false;
  }

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
  scheduleBroadcast();
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

  if (changed) scheduleBroadcast();
}

function allPlayersSubmitted(room) {
  return Boolean(room?.players?.length) && room.players.every((player) => {
    const cards = room.customizations?.[player.id]?.cards;
    return Array.isArray(cards) && cards.length === 5 && cards.every((card) => card?.name && card?.description);
  });
}

function allConfirmed(room) {
  return Boolean(room?.players?.length) && room.players.every((player) => room.confirmations?.[player.id]);
}

function allPicked(room) {
  return Boolean(room?.players?.length) && room.players.every((player) => room.picks?.[player.id]?.mainHeroId && room.picks?.[player.id]?.secondaryHeroId);
}

function shuffleList(values) {
  const list = [...values];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
  }
  return list;
}

function gameFingerprint(game) {
  return JSON.stringify({
    phase: game?.phase,
    cp: game?.currentPlayerId,
    round: game?.round,
    log: (game?.actionLog || [])[0] || '',
    hp: (game?.players || []).map((p) => `${p.id}:${p.hp}`).join('|'),
    hand: (game?.players || []).map((p) => `${p.id}:${(p.hand || []).length}`).join('|'),
    attack: game?.pendingAttack?.targetId || null,
    spell: game?.pendingSpell?.currentTargetId || null,
    rescue: game?.pendingRescue?.targetId || null,
    judgments: (game?.activeJudgments || []).length
  });
}

function applyRoomAction(response, roomCode, session, payload, room) {
  const playerId = String(payload?.playerId || '');
  const player = room.players?.find((item) => item.id === playerId);
  if (!player) {
    sendJson(response, 403, { ok: false, message: '玩家不属于该房间。' });
    return;
  }
  if (!session.canAct(playerId)) {
    sendJson(response, 409, { ok: false, message: '当前不能执行该操作（未轮到你，或未到响应/濒死阶段）。' });
    return;
  }
  session.act({ ...payload, playerId });
  const snapshot = session.snapshot();
  room.game = snapshot;
  session.lastFingerprint = gameFingerprint(snapshot);
  room.revision = (room.revision || 0) + 1;
  room.updatedAt = Date.now();
  scheduleBroadcast();
  sendJson(response, 200, { ok: true, room, game: snapshot, playerId });
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
      totalCount: room.players.length * 5
    };
    touchRoom(room);
    scheduleBroadcast();

    const usedSkillNames = new Set();
    const usedSkillIdsByPlayer = {};
    const llmEnabled = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
    const allCards = [];
    room.players.forEach((player) => {
      (room.customizations[player.id]?.cards || []).slice(0, 5).forEach((card) => {
        allCards.push({ playerId: player.id, name: card.name, description: card.description });
      });
    });
    const skillPlan = llmEnabled
      ? null
      : planFallbackSkills(allCards);
    const generatedByPlayer = {};
    for (let index = 0; index < allCards.length; index += 1) {
      const card = allCards[index];
      const planned = skillPlan?.get(index);
      const aiConfig = room.aiConfig || {};
      const hero = await generateHero(card, {
        usedNames: Array.from(usedSkillNames),
        // 只在本名玩家的 5 张卡内避免重复技能，允许跨玩家复用（库容量有限，无法做到全房间不重样）。
        blockedSkillIds: Array.from(usedSkillIdsByPlayer[card.playerId] || []),
        preferredPrimarySkillId: planned?.primaryId || null,
        preferredSecondarySkillId: planned?.secondaryId || null,
        preferredSpecialSkillId: planned?.specialId || null,
        provider: aiConfig.provider,
        apiKey: aiConfig.apiKey,
        model: aiConfig.model,
        baseUrl: aiConfig.baseUrl
      });
      hero.id = `${card.playerId}-${index}`;
      hero.authorId = card.playerId;
      (generatedByPlayer[card.playerId] = generatedByPlayer[card.playerId] || []).push(hero);
      [hero.primarySkill?.name, hero.secondarySkill?.name, hero.specialSkill?.name].filter(Boolean).forEach((skillName) => usedSkillNames.add(skillName));
      const playerUsed = usedSkillIdsByPlayer[card.playerId] = usedSkillIdsByPlayer[card.playerId] || [];
      [hero.primarySkill?.templateId, hero.secondarySkill?.templateId, hero.specialSkill?.templateId].filter(Boolean).forEach((skillId) => playerUsed.push(skillId));
      const currentRoom = rooms[roomCode];
      if (currentRoom?.heroGeneration?.status === 'RUNNING') {
        currentRoom.heroGeneration.completedCount += 1;
        currentRoom.updatedAt = Date.now();
        scheduleBroadcast();
      }
    }

    const currentRoom = rooms[roomCode];
    if (!currentRoom) return;
    currentRoom.generatedHeroes = generatedByPlayer;
    // 收集各玩家 5 张卡生成来源
    const sources = [];
    Object.values(generatedByPlayer).forEach((heroes) => {
      heroes.forEach((hero) => { if (hero.generationSource !== 'fallback') sources.push(hero.generationSource); });
    });
    currentRoom.heroGeneration = {
      ...currentRoom.heroGeneration,
      status: 'READY',
      completedCount: allCards.length,
      completedAt: Date.now(),
      source: sources[0] || 'fallback'
    };
    delete currentRoom.dealtHands;
    delete currentRoom.confirmations;
    delete currentRoom.picks;
    delete currentRoom.specialCards;
    delete currentRoom.finalHeroes;
    currentRoom.phase = 'REVIEWING';
    touchRoom(currentRoom);
    scheduleBroadcast();
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
      scheduleBroadcast();
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
        if (!result.ok) scheduleBroadcast();
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
      if (!room) {
        sendJson(response, 404, { ok: false, message: '房间不存在或已失效。' });
        return true;
      }
      if (!player) {
        sendJson(response, 403, { ok: false, message: '玩家不属于该房间。' });
        return true;
      }
      if (room.phase === 'PLAYING' && (room.heroGeneration?.status === 'READY' || room.finalHeroes)) {
        sendJson(response, 409, { ok: false, message: '本局英雄已经生成。', room });
        return true;
      }
      const rawCards = Array.isArray(payload.cards) ? payload.cards.slice(0, 5) : [];
      if (rawCards.length !== 5) {
        sendJson(response, 400, { ok: false, message: '请填写 5 张英雄卡。' });
        return true;
      }
      const cards = rawCards.map((card) => {
        const name = String(card?.name || '').trim().slice(0, 16);
        const description = String(card?.description || '').trim().slice(0, 120);
        if (!name || !description) throw new Error('英雄名称和描述不能为空。');
        return { name, description };
      });

      room.customizations = room.customizations || {};
      room.customizations[player.id] = {
        playerId: player.id,
        nickname: player.nickname,
        submittedAt: Date.now(),
        cards
      };
      delete room.generatedHeroes;
      delete room.confirmations;
      delete room.dealtHands;
      delete room.picks;
      delete room.specialCards;
      delete room.finalHeroes;
      room.heroGeneration = { status: 'WAITING' };
      room.phase = 'CUSTOMIZING';
      touchRoom(room);
      scheduleBroadcast();
      if (allPlayersSubmitted(room)) void generateRoomHeroes(roomCode);
      sendJson(response, 202, { ok: true, room, generationStarted: allPlayersSubmitted(room) });
    } catch {
      sendJson(response, 400, { ok: false, message: '无法读取英雄定制数据。' });
    }
    return true;
  }

  const confirmationMatch = requestPath.match(/^\/api\/rooms\/(\d{6})\/confirmations$/);
  if (request.method === 'POST' && confirmationMatch) {
    try {
      const roomCode = confirmationMatch[1];
      const payload = await readJson(request);
      const room = rooms[roomCode];
      const player = room?.players?.find((item) => item.id === payload.playerId);
      if (!room || !player) {
        sendJson(response, 404, { ok: false, message: '房间或玩家不存在。' });
        return true;
      }
      if (room.phase !== 'REVIEWING' || room.heroGeneration?.status !== 'READY') {
        sendJson(response, 409, { ok: false, message: '当前不在英雄确认阶段。' });
        return true;
      }
      room.confirmations = room.confirmations || {};
      room.confirmations[player.id] = true;
      touchRoom(room);
      scheduleBroadcast();
      if (allConfirmed(room)) {
        // 洗乱 20 张英雄卡，随机分发每人 5 张，进入选将阶段。
        const allHeroes = [];
        Object.values(room.generatedHeroes).forEach((heroes) => allHeroes.push(...heroes));
        const shuffled = shuffleList(allHeroes);
        const dealtHands = {};
        room.players.forEach((roomPlayer, index) => {
          dealtHands[roomPlayer.id] = shuffled.slice(index * 5, index * 5 + 5);
        });
        room.dealtHands = dealtHands;
        room.picks = {};
        room.phase = 'SELECTING';
        room.selectDeadline = Date.now() + 60 * 1000;
        touchRoom(room);
        scheduleBroadcast();
      }
      sendJson(response, 200, { ok: true, room });
    } catch {
      sendJson(response, 400, { ok: false, message: '无法读取确认数据。' });
    }
    return true;
  }

  const selectionMatch = requestPath.match(/^\/api\/rooms\/(\d{6})\/selections$/);
  if (request.method === 'POST' && selectionMatch) {
    try {
      const roomCode = selectionMatch[1];
      const payload = await readJson(request);
      const room = rooms[roomCode];
      const player = room?.players?.find((item) => item.id === payload.playerId);
      if (!room || !player) {
        sendJson(response, 404, { ok: false, message: '房间或玩家不存在。' });
        return true;
      }
      if (room.phase !== 'SELECTING') {
        sendJson(response, 409, { ok: false, message: '当前不在选将阶段。' });
        return true;
      }
      const mainHeroId = String(payload.mainHeroId || '');
      const secondaryHeroId = String(payload.secondaryHeroId || '');
      const dealt = room.dealtHands?.[player.id] || [];
      const hasMain = dealt.some((hero) => hero.id === mainHeroId);
      const hasSecondary = dealt.some((hero) => hero.id === secondaryHeroId);
      if (!hasMain || !hasSecondary || mainHeroId === secondaryHeroId) {
        sendJson(response, 400, { ok: false, message: '所选主将和副将必须来自你的手牌且不能相同。' });
        return true;
      }
      room.picks = room.picks || {};
      room.picks[player.id] = { mainHeroId, secondaryHeroId };
      touchRoom(room);
      scheduleBroadcast();
      if (allPicked(room)) {
        const allHeroes = [];
        Object.values(room.generatedHeroes).forEach((heroes) => allHeroes.push(...heroes));
        const heroById = Object.fromEntries(allHeroes.map((hero) => [hero.id, hero]));
        const pickedIds = new Set();
        room.players.forEach((roomPlayer) => {
          const picks = room.picks[roomPlayer.id];
          pickedIds.add(picks.mainHeroId);
          pickedIds.add(picks.secondaryHeroId);
        });
        const specialHeroes = allHeroes.filter((hero) => !pickedIds.has(hero.id));
        room.specialCards = specialHeroes.map((hero, index) => ({
          uid: `special-${index + 1}`,
          type: 'special',
          name: `${hero.heroName}--${hero.specialSkill?.name || '特技'}`,
          effect: hero.specialSkill?.description || '施展英雄的独门特技。',
          specialSkill: hero.specialSkill,
          heroName: hero.heroName
        }));
        room.finalHeroes = {};
        room.players.forEach((roomPlayer) => {
          const picks = room.picks[roomPlayer.id];
          const main = heroById[picks.mainHeroId];
          const secondary = heroById[picks.secondaryHeroId];
          room.finalHeroes[roomPlayer.id] = {
            ...main,
            primarySkill: main.primarySkill,
            secondarySkill: secondary.secondarySkill,
            specialSkill: main.specialSkill,
            mainHeroName: main.heroName,
            secondaryHeroName: secondary.heroName
          };
        });
        room.phase = 'PLAYING';
        room.startedAt = room.startedAt || Date.now();
        // 服务器权威对局：进入对局时，在服务端创建唯一的对局引擎并接管回合推进。
        try {
          const session = createSession(room);
          roomSessions.set(roomCode, session);
          room.game = session.snapshot();
          session.lastFingerprint = gameFingerprint(room.game);
        } catch (error) {
          console.error(`Room ${roomCode} failed to create authoritative session:`, error);
        }
        touchRoom(room);
        scheduleBroadcast();
      }
      sendJson(response, 200, { ok: true, room });
    } catch {
      sendJson(response, 400, { ok: false, message: '无法读取选将数据。' });
    }
    return true;
  }

  const actionMatch = requestPath.match(/^\/api\/rooms\/(\d{6})\/actions$/);
  if (request.method === 'POST' && actionMatch) {
    try {
      const roomCode = actionMatch[1];
      const payload = await readJson(request);
      const room = rooms[roomCode];
      if (!room) {
        sendJson(response, 404, { ok: false, message: '房间不存在或已失效。' });
        return true;
      }
      if (room.phase !== 'PLAYING') {
        sendJson(response, 409, { ok: false, message: '当前不在对局阶段。' });
        return true;
      }
      let session = roomSessions.get(roomCode);
      if (!session) {
        // 兼容旧房间：若未创建权威会话但房间已进入对局，则补建。
        try {
          const created = createSession(room);
          roomSessions.set(roomCode, created);
          session = created;
          room.game = session.snapshot();
          session.lastFingerprint = gameFingerprint(room.game);
        } catch (error) {
          console.error(`Room ${roomCode} session rebuild failed:`, error);
        }
      }
      if (!session) {
        sendJson(response, 409, { ok: false, message: '对局引擎尚未就绪。' });
        return true;
      }
      applyRoomAction(response, roomCode, session, payload, room);
    } catch {
      sendJson(response, 400, { ok: false, message: '无法读取动作数据。' });
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
    const ext = path.extname(filePath).toLowerCase();
    if (!PUBLIC_EXTENSIONS.has(ext)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, max-age=0'
    });
    response.end(data);
  });
}

// 服务器权威对局的驱动循环：每个房间每秒做多次超时结算 + 状态广播。
function serverGameLoop() {
  roomSessions.forEach((session, roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'PLAYING') {
      roomSessions.delete(roomCode);
      return;
    }
    try {
      session.pumpTimers(Date.now());
      session.tick();
      const snapshot = session.snapshot();
      const fingerprint = gameFingerprint(snapshot);
      if (session.lastFingerprint === fingerprint) return;
      session.lastFingerprint = fingerprint;
      room.game = snapshot;
      room.revision = (room.revision || 0) + 1;
      room.updatedAt = Date.now();
      scheduleBroadcast();
    } catch (error) {
      console.error(`Room ${roomCode} authoritative game loop error:`, error);
    }
  });
  // 兜底：已进入对局但尚未生成权威 game 的房间，补建会话并写入 room.game，
  // 避免个别客户端因时序错过创建而一直停在“等待对局状态”。
  Object.keys(rooms).forEach((roomCode) => {
    const room = rooms[roomCode];
    if (room?.phase !== 'PLAYING' || room.game || roomSessions.has(roomCode)) return;
    try {
      const session = createSession(room);
      roomSessions.set(roomCode, session);
      room.game = session.snapshot();
      session.lastFingerprint = gameFingerprint(room.game);
      room.revision = (room.revision || 0) + 1;
      room.updatedAt = Date.now();
      scheduleBroadcast();
    } catch (error) {
      console.error(`Room ${roomCode} authoritative session backfill failed:`, error);
    }
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
  setInterval(serverGameLoop, 250);
});
