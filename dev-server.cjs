const http = require('http');
const fs = require('fs');
const path = require('path');
const { generateHero, planFallbackSkills, reviewRoomBalance, testModelConnection } = require('./hero-generator.cjs');
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
// 房间持久化文件：保存到项目目录，重启后恢复对局；.json 不在可访问扩展名内，不会对外暴露。
const ROOMS_FILE = process.env.WEB_AI_GAME_ROOMS_FILE || path.join(__dirname, 'rooms.json');

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
  if (typeof nextRoom.lastActivityAt !== 'number') nextRoom.lastActivityAt = nextRoom.updatedAt;
  if (typeof nextRoom.paused !== 'boolean') nextRoom.paused = Boolean(nextRoom.paused);
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

// 房间“空置”判定：依据玩家“最后一次操作”（如点击界面、出牌、提交英雄等，即 lastActivityAt），
// 连续 ROOM_IDLE_MS（默认 15 分钟）没有任何操作即判定为空房间并销毁。
// 进行中的对局会自动改写 updatedAt，但只有玩家操作才会改写 lastActivityAt，因此不会因 AI 自动推进而误判为空。
// 可通过环境变量 WEB_AI_GAME_ROOM_IDLE_MS 调整（毫秒），默认 15 分钟，最低 1 分钟。
const ROOM_IDLE_MS = Math.max(60 * 1000, Number(process.env.WEB_AI_GAME_ROOM_IDLE_MS) || 15 * 60 * 1000);

// 玩家“在线/离线”心跳超时：客户端按固定间隔上报 presence，连续超过该时长未上报即判定离线。
// 所有玩家都离线时房间也会被销毁（暂停中除外）。
const OFFLINE_TIMEOUT_MS = Math.max(15 * 1000, Number(process.env.WEB_AI_GAME_OFFLINE_MS) || 90 * 1000);

// 【临时测试配置】每名玩家定制的英雄卡数量。正式规则为 5 张，测试期临时改为 3 张。
// 若需恢复正式玩法：把 CARD_COUNT 改回 5，并同步 customize.html 的 cardCount。
const CARD_COUNT = 3;

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
    if (Array.isArray(room.players)) {
      room.players = room.players.map((player) => {
        const { lastSeen, takenOver, ...rest } = player;
        return rest;
      });
    }
  });
  return nextRooms;
}

// 从磁盘恢复房间，避免服务器重启导致进行中的对局丢失。
try {
  const saved = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  if (saved && typeof saved.rooms === 'object' && saved.rooms) rooms = normalizeRooms(saved.rooms);
} catch {
  // 首次运行或文件不存在/损坏：保持空房间。
}
rooms = normalizeRooms(rooms);

// 持久化采用 800ms 去抖，把对局内高频变更合并写入，且保存时隐去房主填写的 API Key。
let roomsPersistTimer = null;
function sanitizeRoomsForStorage(sourceRooms) {
  const nextRooms = clone(sourceRooms || {});
  Object.values(nextRooms).forEach((room) => {
    if (room?.aiConfig) {
      const safeConfig = { ...room.aiConfig };
      delete safeConfig.apiKey;
      if (Object.keys(safeConfig).length) room.aiConfig = safeConfig;
      else delete room.aiConfig;
    }
    if (Array.isArray(room.players)) {
      room.players = room.players.map((player) => {
        const { lastSeen, takenOver, online, ...rest } = player;
        return rest;
      });
    }
  });
  return nextRooms;
}
function persistRoomsNow() {
  try {
    fs.writeFileSync(ROOMS_FILE, JSON.stringify({ rooms: sanitizeRoomsForStorage(rooms), updatedAt: Date.now() }));
  } catch (error) {
    console.error('Persist rooms failed:', error);
  }
}
function schedulePersistRooms() {
  if (roomsPersistTimer) return;
  roomsPersistTimer = setTimeout(() => {
    roomsPersistTimer = null;
    persistRoomsNow();
  }, 800);
}

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
  schedulePersistRooms();
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
    // 对局已开始的房间不允许再直接添加玩家（已不再支持接管，避免中途乱入）。
    if (currentRoom?.phase === 'PLAYING' && Array.isArray(normalized?.players) && normalized.players.length > (currentRoom.players?.length || 0)) {
      conflicts.push({ roomCode, reason: 'game-action-not-authorized' });
      return;
    }
    preserveAiConfig(currentRoom, normalized);
    if (!gameMutationAllowed(currentRoom, normalized, actorPlayerId)) {
      conflicts.push({ roomCode, reason: 'game-action-not-authorized' });
      return;
    }

    normalized.revision = currentRevision + 1;
    normalized.updatedAt = now;
    // 任何玩家对房间做出的真实修改（创建/加入/准备/改配置等）都算一次“操作”，刷新空置判定。
    normalized.lastActivityAt = now;
    if (actorPlayerId) {
      const actor = (normalized.players || []).find((player) => player.id === String(actorPlayerId));
      if (actor) {
        actor.online = true;
        actor.lastSeen = now;
      }
    }
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

// 房间是否已空置：连续 ROOM_IDLE_MS（默认 5 分钟）没有任何操作（无加入/提交/出牌等状态变更）。
// 进行中的对局会持续改写 updatedAt，因此不会被误删；真正空置/挂机到结束的对局才会被回收。
function roomIdle(room, now) {
  const lastActivity = room?.lastActivityAt || room?.updatedAt || room?.createdAt;
  return Boolean(lastActivity && now - lastActivity >= ROOM_IDLE_MS);
}

// 玩家在线判定：房间内所有玩家都已离线且确实存在过在线状态，则视为“全离线”，应销毁房间。
function allPlayersOffline(room) {
  const players = room?.players || [];
  return players.length > 0 && players.every((player) => player.online === false);
}

// 将心跳超时的玩家标记为离线（仅在已建立过在线状态后才会被置为离线，避免刚加入的玩家被误判）。
function markOfflinePlayers(room, now) {
  if (!room || !Array.isArray(room.players)) return false;
  let changed = false;
  room.players.forEach((player) => {
    if (player.online !== true) return;
    const lastSeen = player.lastSeen || 0;
    if (lastSeen && now - lastSeen >= OFFLINE_TIMEOUT_MS) {
      player.online = false;
      changed = true;
    }
  });
  return changed;
}

// 销毁一个房间及其服务器权威对局引擎：从内存删除房间与 GameSession，并落盘移除，
// 这样服务重启后旧对局不会“复活”。前端会通过广播实时看到房间消失。
function destroyRoom(roomCode) {
  if (!rooms[roomCode]) return;
  roomSessions.delete(roomCode);   // 释放服务器权威对局引擎（推进循环随之停止）
  delete rooms[roomCode];          // 移除房间，客户端广播后即不再可见
  scheduleBroadcast();
  schedulePersistRooms();          // 落盘删除，服务重启后旧对局不会“复活”
  console.log(`[room-sweep] destroyed idle room ${roomCode}`);
}

let lastIdleSweepAt = 0;
// 空置/离线房间回收：每 10 秒扫一次。优先标记心跳超时的玩家为离线；
// 全离线（所有人掉线）或真正空置（连续 15 分钟没有任何玩家操作）即销毁房间。
// 暂停中的房间不做任何计时、也不销毁。
function sweepIdleRooms() {
  const now = Date.now();
  if (now - lastIdleSweepAt < 10 * 1000) return;
  lastIdleSweepAt = now;
  let offlineMarked = false;
  Object.keys(rooms).forEach((roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.phase === 'DISBANDED') return;
    if (room.heroGeneration?.status === 'RUNNING') return;
    if (room.paused) return;                                  // 暂停期间保留房间，不计时、不销毁
    if (markOfflinePlayers(room, now)) offlineMarked = true;
    if (allPlayersOffline(room)) { destroyRoom(roomCode); return; }
    if (roomIdle(room, now)) destroyRoom(roomCode);
  });
  if (offlineMarked) scheduleBroadcast();
}

function allPlayersSubmitted(room) {
  return Boolean(room?.players?.length) && room.players.every((player) => {
    const cards = room.customizations?.[player.id]?.cards;
    return Array.isArray(cards) && cards.length === CARD_COUNT && cards.every((card) => card?.name && card?.description);
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
  if (room.paused) {
    sendJson(response, 409, { ok: false, message: '对局已暂停，无法进行操作。' });
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
  markPlayerActivity(room, playerId);
  scheduleBroadcast();
  sendJson(response, 200, { ok: true, room, game: snapshot, playerId });
}

function touchRoom(room) {
  room.revision = (room.revision || 0) + 1;
  room.updatedAt = Date.now();
}

// 标记一次“玩家操作”：刷新房间的最后活动时间，并同步该玩家的在线状态与最近心跳。
// 只有玩家点击/提交/出牌等真实操作才调用，定时心跳（presence）不经过这里，避免把“在线”误当“活跃”。
function markPlayerActivity(room, playerId) {
  if (!room) return;
  room.lastActivityAt = Date.now();
  if (playerId && Array.isArray(room.players)) {
    const player = room.players.find((item) => item.id === String(playerId));
    if (player) {
      player.online = true;
      player.lastSeen = Date.now();
    }
  }
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
      totalCount: room.players.length * CARD_COUNT
    };
    touchRoom(room);
    scheduleBroadcast();

    const usedSkillNames = new Set();
    const usedSkillIdsByPlayer = {};
    const llmEnabled = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
    const allCards = [];
    room.players.forEach((player) => {
      (room.customizations[player.id]?.cards || []).slice(0, CARD_COUNT).forEach((card) => {
        allCards.push({ playerId: player.id, name: card.name, description: card.description });
      });
    });
    const skillPlan = llmEnabled
      ? null
      : planFallbackSkills(allCards);
    let generatedByPlayer = {};
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
    // 全局平衡与重复度复核（策划 §4.6）：生成完整 20 张后做一次过度集中检测 + 单卡强度检查，
    // 只调整“同角色同一技能超限”的卡，绝不阻塞对局；复核结果写入 heroGeneration 便于审计。
    let reviewReport = null;
    try {
      const review = reviewRoomBalance(generatedByPlayer, { maxRoleDupes: 2 });
      generatedByPlayer = review.heroes;
      reviewReport = review.report;
    } catch (reviewError) {
      console.error(`Room ${roomCode} balance review skipped:`, reviewError);
    }
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
      source: sources[0] || 'fallback',
      balance: reviewReport
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
      const rawCards = Array.isArray(payload.cards) ? payload.cards.slice(0, CARD_COUNT) : [];
      if (rawCards.length !== CARD_COUNT) {
        sendJson(response, 400, { ok: false, message: `请填写 ${CARD_COUNT} 张英雄卡。` });
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
      markPlayerActivity(room, player.id);
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
      markPlayerActivity(room, player.id);
      scheduleBroadcast();
      if (allConfirmed(room)) {
        // 洗乱 20 张英雄卡，随机分发每人 5 张，进入选将阶段。
        const allHeroes = [];
        Object.values(room.generatedHeroes).forEach((heroes) => allHeroes.push(...heroes));
        const shuffled = shuffleList(allHeroes);
        const dealtHands = {};
        room.players.forEach((roomPlayer, index) => {
          dealtHands[roomPlayer.id] = shuffled.slice(index * CARD_COUNT, index * CARD_COUNT + CARD_COUNT);
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
      markPlayerActivity(room, player.id);
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

  // 再来一局：仅房主可发起，且要求本局已结束（room.phase=ENDED）。
  // 复位对局相关字段并回到 CUSTOMIZING，保留 4 名玩家的座位与昵称。
  const rematchMatch = requestPath.match(/^\/api\/rooms\/(\d{6})\/rematch$/);
  if (request.method === 'POST' && rematchMatch) {
    try {
      const roomCode = rematchMatch[1];
      const payload = await readJson(request);
      const room = rooms[roomCode];
      if (!room) {
        sendJson(response, 404, { ok: false, message: '房间不存在或已失效。' });
        return true;
      }
      const actor = room.players?.find((player) => player.id === payload.playerId);
      if (!actor) {
        sendJson(response, 403, { ok: false, message: '玩家不属于该房间。' });
        return true;
      }
      if (actor.role !== 'host') {
        sendJson(response, 409, { ok: false, message: '只有房主可以发起再来一局。' });
        return true;
      }
      if (room.phase !== 'ENDED') {
        sendJson(response, 409, { ok: false, message: '本局尚未结束，暂不能再来一局。' });
        return true;
      }
      // 丢弃权威对局引擎，复位所有对局产物，回到卡牌定制阶段。
      roomSessions.delete(roomCode);
      delete room.game;
      delete room.generatedHeroes;
      delete room.confirmations;
      delete room.dealtHands;
      delete room.picks;
      delete room.specialCards;
      delete room.finalHeroes;
      delete room.heroGeneration;
      delete room.endedAt;
      room.heroGeneration = { status: 'WAITING' };
      room.phase = 'CUSTOMIZING';
      room.players.forEach((player) => {
        player.ready = player.role === 'host';
      });
      touchRoom(room);
      markPlayerActivity(room, actor.id);
      scheduleBroadcast();
      sendJson(response, 200, { ok: true, room });
    } catch {
      sendJson(response, 400, { ok: false, message: '无法读取再来一局数据。' });
    }
    return true;
  }

  // 解散房间：仅房主可发起，任意阶段（等待/试用/对局/结束）都可解散。
  const disbandMatch = requestPath.match(/^\/api\/rooms\/(\d{6})\/disband$/);
  if (request.method === 'POST' && disbandMatch) {
    try {
      const roomCode = disbandMatch[1];
      const payload = await readJson(request);
      const room = rooms[roomCode];
      if (!room) {
        sendJson(response, 404, { ok: false, message: '房间不存在或已失效。' });
        return true;
      }
      const actor = room.players?.find((player) => player.id === payload.playerId);
      if (!actor) {
        sendJson(response, 403, { ok: false, message: '玩家不属于该房间。' });
        return true;
      }
      if (actor.role !== 'host') {
        sendJson(response, 409, { ok: false, message: '只有房主可以解散房间。' });
        return true;
      }
      roomSessions.delete(roomCode);
      delete rooms[roomCode];
      scheduleBroadcast();
      sendJson(response, 200, { ok: true, roomCode });
    } catch {
      sendJson(response, 400, { ok: false, message: '无法读取解散房间数据。' });
    }
    return true;
  }

  // 在线心跳：客户端定期上报，仅刷新玩家 lastSeen/online，不改变 lastActivityAt / revision。
  // 这样“在线”与“活跃（有操作）”分开判定：在线不等于在 15 分钟内有操作。
  const presenceMatch = requestPath.match(/^\/api\/rooms\/(\d{6})\/presence$/);
  if (request.method === 'POST' && presenceMatch) {
    try {
      const roomCode = presenceMatch[1];
      const payload = await readJson(request);
      const room = rooms[roomCode];
      const player = room?.players?.find((item) => item.id === payload.playerId);
      if (!room || !player) {
        sendJson(response, 404, { ok: false, message: '房间或玩家不存在。' });
        return true;
      }
      const firstSeen = player.online !== true;
      player.online = true;
      player.lastSeen = Date.now();
      if (firstSeen) scheduleBroadcast();   // 仅在上线状态变化时广播，避免心跳高频刷屏
      sendJson(response, 200, { ok: true });
    } catch {
      sendJson(response, 400, { ok: false, message: '无效的心跳请求。' });
    }
    return true;
  }

  // 房主暂停/继续对局：暂停时冻结对局推进与 15 分钟空置计时，房间不会被销毁。
  const pauseMatch = requestPath.match(/^\/api\/rooms\/(\d{6})\/pause$/);
  if (request.method === 'POST' && pauseMatch) {
    try {
      const roomCode = pauseMatch[1];
      const payload = await readJson(request);
      const room = rooms[roomCode];
      if (!room) {
        sendJson(response, 404, { ok: false, message: '房间不存在或已失效。' });
        return true;
      }
      const actor = room.players?.find((player) => player.id === payload.playerId);
      if (!actor) {
        sendJson(response, 403, { ok: false, message: '玩家不属于该房间。' });
        return true;
      }
      if (actor.role !== 'host') {
        sendJson(response, 409, { ok: false, message: '只有房主可以暂停或继续对局。' });
        return true;
      }
      if (room.phase !== 'PLAYING') {
        sendJson(response, 409, { ok: false, message: '当前不在对局阶段。' });
        return true;
      }
      const shouldPause = Boolean(payload.paused);
      const session = roomSessions.get(roomCode);
      if (shouldPause) {
        room.paused = true;
        room.pausedAt = Date.now();
      } else {
        const pausedDuration = Date.now() - (room.pausedAt || Date.now());
        // 恢复对局：把“最后操作时间”顺延暂停时长，等效于暂停期间没有进行空置计时，房间不销毁。
        room.lastActivityAt = (room.lastActivityAt || room.updatedAt || Date.now()) + pausedDuration;
        room.paused = false;
        delete room.pausedAt;
        if (session && typeof session.advancePausedTime === 'function') {
          session.advancePausedTime(pausedDuration);
          // 立即刷新 room.game，让客户端看到“顺延后”的倒计时；同时保持指纹不变，避免重复推进。
          const snapshot = session.snapshot();
          room.game = snapshot;
          session.lastFingerprint = gameFingerprint(snapshot);
        } else if (!session) {
          // 恢复时若权威会话缺失（例如暂停期间服务重启），补建会话并复用 room.game 快照继续对局。
          ['turnDeadline', 'drawDeadline', 'responseDeadline', 'matchDeadline', 'turnStartedAt', 'matchStartedAt', 'selectDeadline']
            .forEach((key) => { if (room.game && typeof room.game[key] === 'number') room.game[key] += pausedDuration; });
          const created = createSession(room);
          roomSessions.set(roomCode, created);
          room.game = created.snapshot();
          created.lastFingerprint = gameFingerprint(room.game);
        }
      }
      // 暂停/继续本身也是在线操作：刷新房主在线心跳，但不要重置空置基准（保持暂停计时冻结）。
      actor.online = true;
      actor.lastSeen = Date.now();
      touchRoom(room);
      scheduleBroadcast();
      sendJson(response, 200, { ok: true, room });
    } catch {
      sendJson(response, 400, { ok: false, message: '无法处理暂停操作。' });
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
    if (room.paused) return;   // 暂停：冻结对局推进，不计时、不广播、不销毁
    try {
      session.pumpTimers();
      session.tick();
      const snapshot = session.snapshot();
      // 对局在服务端引擎里已经结算（ENDED）：把房间状态也切到 ENDED，
      // 停止继续推进，并让客户端结局面板出现“再来一局 / 解散房间”。
      if (snapshot?.status === 'ENDED') {
        room.phase = 'ENDED';
        room.game = snapshot;
        room.endedAt = room.endedAt || Date.now();
        room.revision = (room.revision || 0) + 1;
        room.updatedAt = Date.now();
        scheduleBroadcast();
        return;
      }
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
    if (room?.phase !== 'PLAYING' || room.paused || room.game || roomSessions.has(roomCode)) return;
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
  // 空置/离线房间回收：连续 15 分钟没有任何玩家操作，或全员离线，即销毁房间（暂停中除外）。
  sweepIdleRooms();
}

http.createServer(async (request, response) => {
  try {
    const requestPath = decodeURIComponent(request.url.split('?')[0]);

    if (requestPath.startsWith('/api/')) {
      const handled = await handleApi(request, response, requestPath);
      if (!handled) sendJson(response, 404, { ok: false, message: 'API route not found' });
      return;
    }

    serveFile(response, requestPath);
  } catch (error) {
    // 任何一个请求处理抛错都不再让整个进程退出，否则一个坏请求就会导致 systemd 崩溃循环，
    // 全站点击无响应。这里记录日志并尽量返回 500。
    console.error('[webaigame] Unhandled request error:', error);
    try {
      if (!response.headersSent) sendJson(response, 500, { ok: false, message: '服务器内部错误，请稍后重试。' });
    } catch (_) {
      // 连接可能已被关闭（如超大 body 的 request.destroy()），忽略写响应失败。
    }
  }
}).listen(port, host, () => {
  console.log(`天下英雄杀 prototype server: http://127.0.0.1:${port}/`);
  console.log(`Room sync API enabled: http://127.0.0.1:${port}/api/rooms`);
  const llmProvider = process.env.LLM_PROVIDER || (process.env.DEEPSEEK_API_KEY ? 'deepseek' : 'openai');
  const llmEnabled = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
  const llmModel = llmProvider === 'deepseek' ? (process.env.DEEPSEEK_MODEL || 'deepseek-chat') : (process.env.OPENAI_MODEL || 'gpt-4.1-mini');
  console.log(`AI hero generation: ${llmEnabled ? `server env fallback ${llmProvider} (${llmModel})` : 'no server key'} — 房主可在创建房间时选择 DeepSeek/通义千问并填写自己的 API Key，未配置时使用本地兜底生成。`);
  setInterval(serverGameLoop, 250);
});

// 优雅退出：把当前房间立刻落盘，避免 systemctl stop/重启时丢对局。
function shutdownGracefully() {
  if (roomsPersistTimer) { clearTimeout(roomsPersistTimer); roomsPersistTimer = null; }
  try { persistRoomsNow(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', shutdownGracefully);
process.on('SIGINT', shutdownGracefully);

// 安全网：万一还有未捕获的 rejection / 异常，不再让进程直接退出（否则整台服务器反复崩溃）。
// 游戏状态每晚 800ms 落盘，尽量保留进程继续服务，仅记录错误便于排查。
process.on('unhandledRejection', (reason) => {
  console.error('[webaigame] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[webaigame] Uncaught exception (server kept running):', error);
});
