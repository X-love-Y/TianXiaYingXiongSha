'use strict';
// 服务器权威对局端到端验证：建房 -> 生成 -> 确认 -> 选将 -> 进入对局 -> 用 RPC 推进回合。
const BASE = 'http://127.0.0.1:8000';

async function api(path, method, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function shuffle(values) {
  const list = [...values];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function roomCode() { return String(100000 + Math.floor(Math.random() * 900000)); }

async function waitHeroesReady(code, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { payload } = await api('/api/rooms', 'GET');
    const room = payload.rooms[code];
    if (room?.heroGeneration?.status === 'READY' && room.generatedHeroes) return room;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('heroes never became ready');
}

async function main() {
  const code = roomCode();
  const players = ['p1', 'p2', 'p3', 'p4'].map((id, index) => ({ id, nickname: `玩家${index + 1}`, role: index === 0 ? 'host' : 'player' }));

  let result = await api('/api/rooms', 'PUT', {
    changes: { [code]: {
      roomCode: code, phase: 'CUSTOMIZING', mode: 'free', duration: 0,
      players, customizations: {}, confirmations: {}, picks: {}, specialCards: [],
      aiConfig: { provider: 'openai' }, heroGeneration: { status: 'WAITING' }
    } },
    knownRevisions: {}
  });
  if (result.status !== 200) throw new Error('create room failed: ' + JSON.stringify(result.payload));

  const description = '擅长篮球连击和进攻，猛攻压制对手';
  for (const p of players) {
    const cards = Array.from({ length: 5 }, (_, i) => ({ name: `${p.nickname}英雄${i}`, description }));
    result = await api(`/api/rooms/${code}/customizations`, 'POST', { playerId: p.id, cards });
    if (result.status >= 400) throw new Error('submit failed: ' + JSON.stringify(result.payload));
  }

  let room = await waitHeroesReady(code);
  for (const p of players) {
    result = await api(`/api/rooms/${code}/confirmations`, 'POST', { playerId: p.id });
    if (result.status >= 400) throw new Error('confirm failed: ' + JSON.stringify(result.payload));
  }

  room = (await api('/api/rooms', 'GET')).payload.rooms[code];
  for (const p of players) {
    const dealt = room.dealtHands[p.id];
    const [mainHero, secondaryHero] = shuffle(dealt);
    result = await api(`/api/rooms/${code}/selections`, 'POST', { playerId: p.id, mainHeroId: mainHero.id, secondaryHeroId: secondaryHero.id });
    if (result.status >= 400) throw new Error('select failed: ' + JSON.stringify(result.payload));
  }

  room = (await api('/api/rooms', 'GET')).payload.rooms[code];
  if (room.phase !== 'PLAYING') throw new Error('game did not start');
  console.log('PLAYING reached');

  // 服务器权威：读取对局状态，推进回合
  let game = room.game;
  if (!game) throw new Error('server did not produce authoritative game yet');
  // 开局处于先手摸牌 DRAWING，服务器会推进到 PLAY；轮询等待阶段。
  const playDeadline = Date.now() + 6000;
  while (Date.now() < playDeadline) {
    game = (await api('/api/rooms', 'GET')).payload.rooms[code].game;
    if (game?.phase === 'PLAY') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const order = [];
  let cur = game.currentPlayerId;
  for (let i = 0; i < 4; i += 1) {
    // 等待该回合进入可行动的 PLAY 阶段（先手摸牌由服务器推进）
    const waitDeadline = Date.now() + 6000;
    while (Date.now() < waitDeadline) {
      const snap = (await api('/api/rooms', 'GET')).payload.rooms[code].game;
      if (snap?.phase === 'PLAY' && snap.currentPlayerId === cur) { game = snap; break; }
      game = snap;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!game || game.phase !== 'PLAY') throw new Error(`turn ${i + 1}: phase not PLAY for ${cur}`);
    order.push(cur);
    // 当前玩家直接过
    result = await api(`/api/rooms/${code}/actions`, 'POST', { playerId: cur, type: 'pass' });
    if (result.status >= 400) throw new Error(`pass failed for ${cur}: ` + JSON.stringify(result.payload));
    const next = result.payload.game?.currentPlayerId;
    if (!next) throw new Error('no currentPlayerId in server game after pass');
    console.log(`turn ${i + 1}: ${cur} -> ${next}`);
    cur = next;
  }
  console.log('server-authoritative turn order:', order.join(' -> '));
  if (new Set(order).size < 4) throw new Error('turn order did not cycle through 4 players');
  console.log('SERVER AUTHORITY OK');
}

main().catch((error) => { console.error(error); process.exit(1); });
