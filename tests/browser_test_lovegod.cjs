'use strict';
const cdp = require('./cdp.cjs');
const path = require('path');

const CDP_PORT = 9223;
const BASE = 'http://127.0.0.1:8000';
const SHOT_DIR = path.join(__dirname, 'shots');

function makeRoom(code) {
  return {
    roomCode: code,
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
      p1: { heroName: '玩家一的英雄', maxHpBonus: 0, flavorText: '测试英雄' },
      p2: { heroName: '玩家二的英雄', maxHpBonus: 0, flavorText: '测试英雄' }
    }
  };
}

// Offline mode: network.js is blocked, so saveRooms falls back to plain localStorage
// writes and storage events sync between tabs without server revision interference.
async function loadGameTab(client, roomCode, playerId) {
  await cdp.navigate(client, `${BASE}/lobby.html`);
  await cdp.evalJs(client, `(() => {
    const rooms = JSON.parse(localStorage.getItem('heroKillLocalRooms') || '{}');
    if (!rooms['${roomCode}']) {
      rooms['${roomCode}'] = ${JSON.stringify(makeRoom(roomCode))};
      localStorage.setItem('heroKillLocalRooms', JSON.stringify(rooms));
    }
    sessionStorage.setItem('heroKillRoomSession', JSON.stringify({ roomCode: '${roomCode}', playerId: '${playerId}' }));
  })()`);
  await cdp.navigate(client, `${BASE}/game.html`);
  await cdp.waitFor(client, `(() => {
    try {
      const g = JSON.parse(localStorage.getItem('heroKillLocalRooms'))['${roomCode}']?.game;
      return Boolean(g && g.status === 'PLAYING' && g.players.some((p) => p.id === '${playerId}'));
    } catch (e) { return false; }
  })()`, 20000);
  await cdp.waitFor(client, `typeof gameState !== 'undefined' && gameState !== null && gameState.status === 'PLAYING'`, 10000);
}

async function setupScenario(clientA, clientB, roomCode, options = {}) {
  const { p2HasUntargetable = false, p1HasUntargetable = false } = options;
  const p2Hand = p2HasUntargetable
    ? [{ uid: 'unt-p2', type: 'untargetable', name: '无法选中', suit: '♥', point: 2, pointLabel: '2' }]
    : [];
  const p1Hand = [{ uid: 'lg-x', type: 'love-god', name: '爱神', effect: '指定两名存活玩家，将二人当前血量相加后平均分配。', suit: '♦', point: 9, pointLabel: '9' }];
  if (p1HasUntargetable) p1Hand.push({ uid: 'unt-p1', type: 'untargetable', name: '无法选中', suit: '♥', point: 2, pointLabel: '2' });
  await cdp.evalJs(clientA, `(() => {
    gameState.status = 'PLAYING';
    gameState.phase = 'PLAY';
    gameState.currentPlayerId = 'p1';
    gameState.round = 1;
    gameState.killUsed = false;
    gameState.skipPlayRound = 0;
    gameState.pendingSpell = null;
    gameState.pendingAttack = null;
    gameState.pendingRescue = null;
    gameState.responseDeadline = null;
    gameState.drawDeadline = null;
    gameState.drawPlayerId = null;
    gameState.activeJudgments = [];
    gameState.deck = [];
    gameState.discardPile = [];
    gameState.players.forEach((p) => {
      p.alive = true;
      p.hp = p.maxHp;
      p.weapon = null;
      p.weaponUsage = {};
      p.statusEffects = {};
      p.skillUsage = {};
      p.maxHp = 4;
    });
    gameState.players[0].hp = 2;
    gameState.players[1].hp = 4;
    gameState.players[0].hand = ${JSON.stringify(p1Hand)};
    gameState.players[1].hand = ${JSON.stringify(p2Hand)};
    selectedCardUid = null;
    selectedTargetId = null;
    selectedSecondaryTargetId = null;
    currentPlayer = gameState.players[0];
    persistGame();
    render();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 900));
  // Verify tab B received the setup.
  const synced = await cdp.evalJs(clientB, `(() => {
    const room = JSON.parse(localStorage.getItem('heroKillLocalRooms'))['${roomCode}'];
    return Boolean(room?.game && room.game.players[0].maxHp === 4 && room.game.players[0].hand.some((c) => c.uid === 'lg-x'));
  })()`);
  return synced;
}

async function stateOf(client) {
  return cdp.evalJs(client, `(() => {
    const s = gameState;
    const pending = s.pendingSpell;
    return {
      phase: s.phase, status: s.status, currentPlayerId: s.currentPlayerId,
      pendingSpell: pending ? { kind: pending.kind, currentTargetId: pending.currentTargetId, targetIds: pending.targetIds, targetIndex: pending.targetIndex, affectedIds: pending.affectedIds } : null,
      players: s.players.map((p) => ({ id: p.id, hp: p.hp, maxHp: p.maxHp, alive: p.alive, hand: p.hand.map((c) => c.uid), statusEffects: p.statusEffects })),
      selectedCardUid, selectedTargetId, selectedSecondaryTargetId,
      responseVisible: document.getElementById('responsePanel').classList.contains('visible'),
      responseTitle: document.getElementById('responseTitle').textContent,
      respondDodgeDisabled: document.getElementById('respondDodge').disabled,
      takeDamageDisabled: document.getElementById('takeDamage').disabled,
      useCardDisabled: document.getElementById('useCard').disabled,
      helper: document.getElementById('helperText').textContent
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
    await cdp.enableFetchBlock(clientA, 'network.js');
    const tabB = await cdp.newTab(CDP_PORT, 'about:blank');
    clientB = await cdp.connectToTab(tabB);
    await cdp.enableFetchBlock(clientB, 'network.js');

    const scenarios = [
      {
        name: 'S1 self+other no-unt',
        options: {},
        run: async () => {
      await cdp.evalJs(clientA, `document.querySelector('[data-card-uid="lg-x"]').click()`);
      await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p1').click()`);
      await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p2').click()`);
      const useDisabled = await cdp.evalJs(clientA, `document.getElementById('useCard').disabled`);
      await cdp.evalJs(clientA, `document.getElementById('useCard').click()`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const a = await stateOf(clientA);
      const b = await stateOf(clientB);
      const ok = a.phase === 'PLAY' && a.pendingSpell === null && a.players[0].hp === 3 && a.players[1].hp === 3;
      return { ok, extra: `useDisabled=${useDisabled} A=${JSON.stringify({ phase: a.phase, hp: a.players.map((p) => p.hp), spell: a.pendingSpell })} B=${JSON.stringify({ phase: b.phase, hp: b.players.map((p) => p.hp) })}` };
        }
      },
      {
        name: 'S2 other-unt accept',
        options: { p2HasUntargetable: true },
        run: async () => {
      await cdp.evalJs(clientA, `document.querySelector('[data-card-uid="lg-x"]').click()`);
      await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p1').click()`);
      await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p2').click()`);
      await cdp.evalJs(clientA, `document.getElementById('useCard').click()`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const a1 = await stateOf(clientA);
      const b1 = await stateOf(clientB);
      const enteredResponse = a1.phase === 'RESPONSE' && a1.pendingSpell?.currentTargetId === 'p2';
      // p2 accepts
      await cdp.evalJs(clientB, `document.getElementById('takeDamage').click()`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const a2 = await stateOf(clientA);
      const b2 = await stateOf(clientB);
      const ok = enteredResponse && a2.phase === 'PLAY' && a2.pendingSpell === null && a2.players[0].hp === 3 && a2.players[1].hp === 3;
      return { ok, extra: `entered=${enteredResponse} B1=${JSON.stringify({ phase: b1.phase, title: b1.responseTitle, visible: b1.responseVisible })} A2=${JSON.stringify({ phase: a2.phase, hp: a2.players.map((p) => p.hp) })} B2=${JSON.stringify({ phase: b2.phase, hp: b2.players.map((p) => p.hp) })}` };
        }
      },
      {
        name: 'S3 self-unt accept',
        options: { p1HasUntargetable: true },
        run: async () => {
      await cdp.evalJs(clientA, `document.querySelector('[data-card-uid="lg-x"]').click()`);
      await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p1').click()`);
      await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p2').click()`);
      await cdp.evalJs(clientA, `document.getElementById('useCard').click()`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const a1 = await stateOf(clientA);
      const b1 = await stateOf(clientB);
      const enteredResponse = a1.phase === 'RESPONSE' && a1.pendingSpell?.currentTargetId === 'p1';
      const responseShownToCaster = a1.responseVisible && a1.responseTitle.includes('爱神');
      // caster accepts own spell
      await cdp.evalJs(clientA, `document.getElementById('takeDamage').click()`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const a2 = await stateOf(clientA);
      const b2 = await stateOf(clientB);
      const ok = enteredResponse && responseShownToCaster && a2.phase === 'PLAY' && a2.pendingSpell === null && a2.players[0].hp === 3 && a2.players[1].hp === 3;
      return { ok, extra: `entered=${enteredResponse} shown=${responseShownToCaster} A1=${JSON.stringify({ phase: a1.phase, title: a1.responseTitle, visible: a1.responseVisible, respondDisabled: a1.respondDodgeDisabled })} B1=${JSON.stringify({ phase: b1.phase, visible: b1.responseVisible })} A2=${JSON.stringify({ phase: a2.phase, hp: a2.players.map((p) => p.hp) })} B2=${JSON.stringify({ phase: b2.phase, hp: b2.players.map((p) => p.hp) })}` };
        }
      },
      {
        name: 'S4 self-unt cancel-self',
        options: { p1HasUntargetable: true },
        run: async () => {
      await cdp.evalJs(clientA, `document.querySelector('[data-card-uid="lg-x"]').click()`);
      await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p1').click()`);
      await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p2').click()`);
      await cdp.evalJs(clientA, `document.getElementById('useCard').click()`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const a1 = await stateOf(clientA);
      // caster cancels themselves with 无法选中
      await cdp.evalJs(clientA, `document.querySelector('[data-card-uid="unt-p1"]').click()`);
      await cdp.evalJs(clientA, `document.getElementById('respondDodge').click()`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      const a2 = await stateOf(clientA);
      const b2 = await stateOf(clientB);
      const ok = a1.phase === 'RESPONSE' && a1.pendingSpell?.currentTargetId === 'p1' && a2.phase === 'PLAY' && a2.pendingSpell === null;
      return { ok, extra: `A1=${JSON.stringify({ phase: a1.phase, target: a1.pendingSpell?.currentTargetId })} A2=${JSON.stringify({ phase: a2.phase, hp: a2.players.map((p) => p.hp) })} B2=${JSON.stringify({ phase: b2.phase, hp: b2.players.map((p) => p.hp) })}` };
        }
      }
    ];

    const results = [];
    for (const scenario of scenarios) {
      const roomCode = String(100000 + Math.floor(Math.random() * 900000));
      await loadGameTab(clientA, roomCode, 'p1');
      await loadGameTab(clientB, roomCode, 'p2');
      const synced = await setupScenario(clientA, clientB, roomCode, scenario.options);
      if (!synced) {
        results.push({ name: scenario.name, ok: false, extra: 'setup not synced to tab B' });
        continue;
      }
      try {
        const outcome = await scenario.run();
        results.push({ name: scenario.name, ok: outcome.ok, extra: outcome.extra });
      } catch (error) {
        let aState = 'n/a';
        let bState = 'n/a';
        try { aState = JSON.stringify(await stateOf(clientA)); } catch (e) {}
        try { bState = JSON.stringify(await stateOf(clientB)); } catch (e) {}
        results.push({ name: scenario.name, ok: false, extra: `exception: ${error.message}; A=${aState}; B=${bState}` });
      }
    }

    let failures = 0;
    results.forEach((r) => {
      if (!r.ok) failures += 1;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.extra}`);
    });
    console.log(`\n${results.length - failures}/${results.length} scenarios passed, ${failures} failed`);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (clientA) await clientA.close().catch(() => {});
    if (clientB) await clientB.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    chrome.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
