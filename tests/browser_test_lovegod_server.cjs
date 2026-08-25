'use strict';
const cdp = require('./cdp.cjs');

const CDP_PORT = 9226;
const BASE = 'http://49.233.20.220:8000';
const ROOM_CODE = String(100000 + Math.floor(Math.random() * 900000));

function makeRoom() {
  return {
    roomCode: ROOM_CODE,
    schemaVersion: 1,
    revision: 0,
    password: '123456',
    mode: 'survival',
    duration: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'PLAYING',
    players: [
      { id: 'p1', nickname: '玩家一', role: 'host', ready: true },
      { id: 'p2', nickname: '玩家二', role: 'guest', ready: true }
    ],
    heroGeneration: { status: 'READY' },
    generatedHeroes: {
      p1: { heroName: '英雄一', maxHpBonus: 0, flavorText: '测试' },
      p2: { heroName: '英雄二', maxHpBonus: 0, flavorText: '测试' }
    }
  };
}

async function seedAndLoad(client, playerId) {
  await cdp.navigate(client, `${BASE}/lobby.html`);
  await cdp.waitFor(client, `typeof HeroKillNet !== 'undefined'`, 15000);
  await cdp.evalJs(client, `(async () => {
    await HeroKillNet.loadRooms();
    const rooms = HeroKillNet.readLocalRooms();
    if (!rooms['${ROOM_CODE}']) {
      rooms['${ROOM_CODE}'] = ${JSON.stringify(makeRoom())};
      await HeroKillNet.saveRooms(rooms);
    }
    return true;
  })()`, true);
  await cdp.evalJs(client, `(() => {
    sessionStorage.setItem('heroKillRoomSession', JSON.stringify({ roomCode: '${ROOM_CODE}', playerId: '${playerId}' }));
  })()`);
  await cdp.navigate(client, `${BASE}/game.html`);
  await cdp.waitFor(client, `(() => {
    try {
      const g = JSON.parse(localStorage.getItem('heroKillLocalRooms'))['${ROOM_CODE}']?.game;
      return Boolean(g && g.status === 'PLAYING' && g.players.some((p) => p.id === '${playerId}'));
    } catch (e) { return false; }
  })()`, 25000);
  await cdp.waitFor(client, `typeof gameState !== 'undefined' && gameState !== null && gameState.status === 'PLAYING'`, 10000);
}

async function stateOf(client) {
  return cdp.evalJs(client, `(() => {
    const s = gameState;
    const pending = s.pendingSpell;
    return {
      phase: s.phase, status: s.status, currentPlayerId: s.currentPlayerId,
      pendingSpell: pending ? { kind: pending.kind, currentTargetId: pending.currentTargetId, affectedIds: pending.affectedIds, targetIds: pending.targetIds, targetIndex: pending.targetIndex } : null,
      players: s.players.map((p) => ({ id: p.id, hp: p.hp, maxHp: p.maxHp, hand: p.hand.map((c) => c.uid) })),
      responseVisible: document.getElementById('responsePanel').classList.contains('visible'),
      responseTitle: document.getElementById('responseTitle').textContent
    };
  })()`);
}

async function main() {
  const { chrome } = await cdp.launchChrome(CDP_PORT);
  let clientA = null;
  let clientB = null;
  try {
    const tabA = await cdp.newTab(CDP_PORT, 'about:blank');
    clientA = await cdp.connectToTab(tabA);
    await seedAndLoad(clientA, 'p1');
    const tabB = await cdp.newTab(CDP_PORT, 'about:blank');
    clientB = await cdp.connectToTab(tabB);
    await seedAndLoad(clientB, 'p2');

    await cdp.evalJs(clientA, `(() => {
      gameState.status = 'PLAYING';
      gameState.phase = 'PLAY';
      gameState.currentPlayerId = 'p1';
      gameState.round = 1;
      gameState.killUsed = false;
      gameState.pendingSpell = null;
      gameState.pendingAttack = null;
      gameState.pendingRescue = null;
      gameState.responseDeadline = null;
      gameState.drawDeadline = null;
      gameState.activeJudgments = [];
      gameState.deck = [];
      gameState.discardPile = [];
      gameState.turnDeadline = Date.now() + 3600000;
      gameState.players.forEach((p) => {
        p.alive = true;
        p.hp = p.maxHp;
        p.hand = [];
        p.weapon = null;
        p.weaponUsage = {};
        p.statusEffects = {};
        p.skillUsage = {};
        p.maxHp = 8;
      });
      gameState.players[0].hp = 2;
      gameState.players[1].hp = 4;
      gameState.players[0].hand = [
        { uid: 'lg-x', type: 'love-god', name: '爱神', effect: 'x', suit: '♦', point: 9, pointLabel: '9' },
        { uid: 'unt-p1', type: 'untargetable', name: '无法选中', suit: '♥', point: 2, pointLabel: '2' }
      ];
      gameState.players[1].hand = [{ uid: 'unt-p2', type: 'untargetable', name: '无法选中', suit: '♥', point: 3, pointLabel: '3' }];
      selectedCardUid = null;
      selectedTargetId = null;
      selectedSecondaryTargetId = null;
      currentPlayer = gameState.players[0];
      persistGame();
      render();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const syncB = await cdp.evalJs(clientB, `(() => {
      const room = JSON.parse(localStorage.getItem('heroKillLocalRooms'))['${ROOM_CODE}'];
      return Boolean(room?.game && room.game.players[0].hand.some((c) => c.uid === 'lg-x'));
    })()`);
    console.log('syncB=', syncB);

    // Caster selects 爱神, targets self then p2, clicks 使用.
    await cdp.evalJs(clientA, `document.querySelector('[data-card-uid="lg-x"]').click()`);
    await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p1').click()`);
    await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p2').click()`);
    await cdp.evalJs(clientA, `document.getElementById('useCard').click()`);
    await new Promise((resolve) => setTimeout(resolve, 900));

    const a1 = await stateOf(clientA);
    console.log('STEP1 A=', JSON.stringify(a1));
    const step1Ok = a1.phase === 'RESPONSE' && a1.pendingSpell?.currentTargetId === 'p1';

    // Caster (p1) accepts own spell via 承受效果.
    await cdp.evalJs(clientA, `document.getElementById('takeDamage').click()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const a2 = await stateOf(clientA);
    console.log('STEP2 A=', JSON.stringify(a2));
    const step2Ok = a2.phase === 'RESPONSE' && a2.pendingSpell?.currentTargetId === 'p2';

    // p2 accepts.
    await cdp.evalJs(clientB, `document.getElementById('takeDamage').click()`);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const a3 = await stateOf(clientA);
    const b3 = await stateOf(clientB);
    console.log('STEP3 A=', JSON.stringify(a3));
    console.log('STEP3 B=', JSON.stringify(b3));
    const step3Ok = a3.phase === 'PLAY' && a3.pendingSpell === null && a3.players[0].hp === 3 && a3.players[1].hp === 3 && b3.phase === 'PLAY';

    console.log(`RESULT step1=${step1Ok} step2=${step2Ok} step3=${step3Ok}`);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (clientA) await clientA.close().catch(() => {});
    if (clientB) await clientB.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    chrome.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
