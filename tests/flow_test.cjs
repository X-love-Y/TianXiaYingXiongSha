'use strict';
// End-to-end API flow test: room -> 4 players x 5 cards -> AI generate -> confirm -> deal -> select -> special cards.
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

function roomCode() {
  return String(100000 + Math.floor(Math.random() * 900000));
}

async function waitHeroesReady(code, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { payload } = await api('/api/rooms', 'GET');
    const room = payload.rooms[code];
    if (!room) throw new Error('room missing');
    if (room.heroGeneration?.status === 'READY') return room;
    if (room.heroGeneration?.status === 'FAILED') throw new Error('generation failed: ' + room.heroGeneration.message);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('hero generation timed out');
}

async function main() {
  const code = roomCode();
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
  if (process.env.AI_KEY) {
    room.aiConfig = {
      provider: process.env.AI_PROVIDER || 'deepseek',
      apiKey: process.env.AI_KEY,
      model: process.env.AI_MODEL || 'deepseek-chat'
    };
  }

  // 1. Create room
  let result = await api('/api/rooms', 'PUT', { changes: { [code]: room }, knownRevisions: {}, actorPlayerId: 'p1' });
  console.log('1 create room:', result.status);
  if (result.status !== 200) throw new Error(JSON.stringify(result.payload));

  // 2. Four players submit 5 cards each
  for (const player of players) {
    const cards = Array.from({ length: 5 }, (_, index) => ({
      name: `${player.nickname}英雄${index + 1}`,
      description: `擅长猛攻与守护的强者，性格${['豪迈', '冷静', '开朗', '沉稳'][players.indexOf(player) % 4]}。`
    }));
    result = await api(`/api/rooms/${code}/customizations`, 'POST', { playerId: player.id, cards });
    console.log(`2 submit ${player.id}:`, result.status, result.payload.generationStarted ? '(generation started)' : '');
    if (result.status >= 400) throw new Error(JSON.stringify(result.payload));
  }

  // 3. Wait for generation (fallback, no aiConfig)
  let roomState = await waitHeroesReady(code, 60000);
  const heroCount = Object.values(roomState.generatedHeroes).reduce((sum, heroes) => sum + heroes.length, 0);
  console.log('3 generated heroes total:', heroCount, 'phase=', roomState.phase);
  if (heroCount !== 20 || roomState.phase !== 'REVIEWING') throw new Error('unexpected generation result');
  let withinCardDupes = 0;
  const allNames = new Set();
  let nameDupes = 0;
  Object.values(roomState.generatedHeroes).forEach((heroes) => {
    heroes.forEach((hero) => {
      const ids = [hero.primarySkill?.templateId, hero.secondarySkill?.templateId, hero.specialSkill?.templateId];
      if (new Set(ids).size !== 3) withinCardDupes += 1;
      [hero.primarySkill?.name, hero.secondarySkill?.name, hero.specialSkill?.name].forEach((name) => {
        if (allNames.has(name)) nameDupes += 1;
        allNames.add(name);
      });
    });
  });
  console.log('3b within-card skill duplicates:', withinCardDupes, 'name duplicates:', nameDupes);
  if (withinCardDupes || nameDupes) throw new Error('skill assignment violated uniqueness');

  // 4. All players confirm -> dealt hands
  for (const player of players) {
    result = await api(`/api/rooms/${code}/confirmations`, 'POST', { playerId: player.id });
    console.log(`4 confirm ${player.id}:`, result.status, 'phase=', result.payload.room?.phase);
  }
  roomState = await api('/api/rooms', 'GET').then((r) => r.payload.rooms[code]);
  const dealtCount = Object.values(roomState.dealtHands || {}).reduce((sum, heroes) => sum + heroes.length, 0);
  console.log('5 dealt total:', dealtCount, 'phase=', roomState.phase);
  if (dealtCount !== 20 || roomState.phase !== 'SELECTING') throw new Error('deal failed');

  // 5. Each player picks main + secondary from their dealt hand
  for (const player of players) {
    const dealt = roomState.dealtHands[player.id];
    const [mainHero, secondaryHero] = shuffle(dealt);
    result = await api(`/api/rooms/${code}/selections`, 'POST', { playerId: player.id, mainHeroId: mainHero.id, secondaryHeroId: secondaryHero.id });
    console.log(`6 select ${player.id}:`, result.status, 'phase=', result.payload.room?.phase);
    if (result.status >= 400) throw new Error(JSON.stringify(result.payload));
  }

  roomState = await api('/api/rooms', 'GET').then((r) => r.payload.rooms[code]);
  console.log('7 final phase=', roomState.phase, 'specialCards=', roomState.specialCards?.length, 'finalHeroes=', Object.keys(roomState.finalHeroes || {}).length);
  if (roomState.phase !== 'PLAYING') throw new Error('game did not start');
  if (roomState.specialCards?.length !== 12) throw new Error('expected 12 special cards');

  // Verify each final hero has primary from main and secondary from secondary pick
  const first = roomState.finalHeroes.p1;
  if (!first?.primarySkill?.templateId || !first?.secondarySkill?.templateId || !first?.specialSkill?.templateId) {
    throw new Error('final hero missing skills');
  }
  if (first.primarySkill.templateId === first.secondarySkill.templateId || first.primarySkill.templateId === first.specialSkill.templateId || first.secondarySkill.templateId === first.specialSkill.templateId) {
    throw new Error('final hero skills duplicate');
  }
  console.log('8 final hero p1:', JSON.stringify({ name: first.heroName, maxHp: first.maxHp, primary: first.primarySkill.templateId, secondary: first.secondarySkill.templateId, special: first.specialSkill.templateId }));
  console.log('FLOW OK');
}

main().catch((error) => { console.error(error); process.exit(1); });
