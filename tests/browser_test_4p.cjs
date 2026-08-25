'use strict';
const cdp = require('./cdp.cjs');
const path = require('path');

const CDP_PORT = 9227;
const BASE = 'http://127.0.0.1:8000';
const SHOT_DIR = path.join(__dirname, 'shots');

async function api(base, pathname, method, body) {
  const response = await fetch(`${base}${pathname}`, {
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

async function buildReadyRoom() {
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const players = [
    { id: 'p1', nickname: '玩家一', role: 'host', ready: true },
    { id: 'p2', nickname: '玩家二', role: 'guest', ready: true },
    { id: 'p3', nickname: '玩家三', role: 'guest', ready: true },
    { id: 'p4', nickname: '玩家四', role: 'guest', ready: true }
  ];
  const room = {
    roomCode: code,
    schemaVersion: 1,
    revision: 0,
    password: '123456',
    mode: 'survival',
    duration: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'CUSTOMIZING',
    players,
    heroGeneration: { status: 'WAITING' }
  };
  let result = await api(BASE, '/api/rooms', 'PUT', { changes: { [code]: room }, knownRevisions: {}, actorPlayerId: 'p1' });
  if (result.status !== 200) throw new Error('room create failed');
  for (const player of players) {
    const cards = Array.from({ length: 5 }, (_, index) => ({
      name: `${player.nickname}英雄${index + 1}`,
      description: `擅长猛攻与守护的强者，性格${['豪迈', '冷静', '开朗', '沉稳'][players.indexOf(player)]}。`
    }));
    result = await api(BASE, `/api/rooms/${code}/customizations`, 'POST', { playerId: player.id, cards });
    if (result.status >= 400) throw new Error('customization failed: ' + JSON.stringify(result.payload));
  }
  const deadline = Date.now() + 60000;
  let roomState = null;
  while (Date.now() < deadline) {
    roomState = (await api(BASE, '/api/rooms', 'GET')).payload.rooms[code];
    if (roomState?.heroGeneration?.status === 'READY') break;
    if (roomState?.heroGeneration?.status === 'FAILED') throw new Error('generation failed');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (roomState?.phase !== 'REVIEWING') throw new Error('not reviewing');
  for (const player of players) {
    await api(BASE, `/api/rooms/${code}/confirmations`, 'POST', { playerId: player.id });
  }
  roomState = (await api(BASE, '/api/rooms', 'GET')).payload.rooms[code];
  if (roomState?.phase !== 'SELECTING') throw new Error('not selecting');
  for (const player of players) {
    const dealt = roomState.dealtHands[player.id];
    const [mainHero, secondaryHero] = shuffle(dealt);
    result = await api(BASE, `/api/rooms/${code}/selections`, 'POST', { playerId: player.id, mainHeroId: mainHero.id, secondaryHeroId: secondaryHero.id });
    if (result.status >= 400) throw new Error('selection failed: ' + JSON.stringify(result.payload));
  }
  roomState = (await api(BASE, '/api/rooms', 'GET')).payload.rooms[code];
  if (roomState?.phase !== 'PLAYING' || roomState.specialCards?.length !== 12) throw new Error('game not ready');
  return { code, roomState };
}

async function loadPlayerTab(client, code, playerId) {
  await cdp.navigate(client, `${BASE}/lobby.html`);
  await cdp.evalJs(client, `(() => {
    sessionStorage.setItem('heroKillRoomSession', JSON.stringify({ roomCode: '${code}', playerId: '${playerId}' }));
  })()`);
  await cdp.navigate(client, `${BASE}/game.html`);
  await cdp.waitFor(client, `typeof gameState !== 'undefined' && gameState !== null && gameState.status === 'PLAYING'`, 25000);
}

async function stateOf(client) {
  return cdp.evalJs(client, `(() => {
    const s = gameState;
    return {
      phase: s.phase,
      players: s.players.map((p) => ({ id: p.id, nickname: p.nickname, maxHp: p.maxHp, hp: p.hp })),
      deckHasSpecial: s.deck.some((c) => c.type === 'special') || s.discardPile.some((c) => c.type === 'special'),
      specialInDeck: s.deck.filter((c) => c.type === 'special').length,
      deckCount: s.deck.length,
      seats: ['seat0', 'seat1', 'seat2', 'seat3'].map((id) => document.getElementById(id).innerText.slice(0, 12)),
      adjacency: {
        p1p2: areAdjacent('p1', 'p2'),
        p1p3: areAdjacent('p1', 'p3'),
        p1p4: areAdjacent('p1', 'p4'),
        p2p3: areAdjacent('p2', 'p3')
      }
    };
  })()`);
}

async function main() {
  const { code } = await buildReadyRoom();
  const { chrome } = await cdp.launchChrome(CDP_PORT);
  const clients = [];
  try {
    for (let index = 1; index <= 4; index += 1) {
      const tab = await cdp.newTab(CDP_PORT, 'about:blank');
      const client = await cdp.connectToTab(tab);
      clients.push(client);
      await loadPlayerTab(client, code, 'p' + index);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // 等所有标签页度过初始摸牌阶段，避免出牌阶段切换的持久化干扰后续测试
    for (const client of clients) {
      await cdp.waitFor(client, `gameState.phase === 'PLAY' || gameState.phase === 'DISCARD' || gameState.phase === 'ENDED'`, 20000);
    }
    await new Promise((resolve) => setTimeout(resolve, 800));

    const results = [];
    const states = [];
    for (let index = 0; index < 4; index += 1) {
      const state = await stateOf(clients[index]);
      states.push(state);
      results.push({
        name: `玩家${'一二三四'[index]} 视角座位固定`,
        ok: state.seats[0].includes('玩家一') && state.seats[1].includes('玩家二') && state.seats[2].includes('玩家三') && state.seats[3].includes('玩家四'),
        extra: JSON.stringify(state.seats)
      });
    }
    const s0 = states[0];
    results.push({
      name: '特技牌进入牌堆',
      ok: s0.specialInDeck > 0 && s0.deckHasSpecial,
      extra: `specialInDeck=${s0.specialInDeck} deckCount=${s0.deckCount}`
    });
    results.push({
      name: '相邻判定按固定座位',
      ok: s0.adjacency.p1p2 === true && s0.adjacency.p1p3 === false && s0.adjacency.p1p4 === true && s0.adjacency.p2p3 === true,
      extra: JSON.stringify(s0.adjacency)
    });

    let failures = 0;
    results.forEach((r) => {
      if (!r.ok) failures += 1;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.extra}`);
    });
    console.log(`\n${results.length - failures}/${results.length} passed, ${failures} failed`);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    chrome.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
