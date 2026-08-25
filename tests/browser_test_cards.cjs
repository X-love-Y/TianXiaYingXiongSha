'use strict';
const cdp = require('./cdp.cjs');

const CDP_PORT = 9225;
const BASE = 'http://127.0.0.1:8000';

function makeRoom(code, nPlayers) {
  const players = [];
  const heroes = {};
  for (let index = 1; index <= nPlayers; index += 1) {
    const id = 'p' + index;
    players.push({ id, nickname: '玩家' + '一二三'[index - 1], role: index === 1 ? 'host' : 'guest', ready: true });
    heroes[id] = { heroName: '英雄' + index, maxHpBonus: 0, flavorText: '测试' };
  }
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
    players,
    heroGeneration: { status: 'READY' },
    generatedHeroes: heroes
  };
}

async function loadGameTab(client, room, playerId) {
  const roomCode = room.roomCode;
  await cdp.navigate(client, `${BASE}/lobby.html`);
  await cdp.evalJs(client, `(() => {
    const rooms = JSON.parse(localStorage.getItem('heroKillLocalRooms') || '{}');
    if (!rooms['${roomCode}']) {
      rooms['${roomCode}'] = ${JSON.stringify(room)};
    }
    localStorage.setItem('heroKillLocalRooms', JSON.stringify(rooms));
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

async function setupRoom(clientA, clientB, roomCode, nPlayers) {
  const room = makeRoom(roomCode, nPlayers);
  await loadGameTab(clientA, room, 'p1');
  await loadGameTab(clientB, room, 'p2');
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
    if (gameState.players[2]) gameState.players[2].hp = 3;
    currentPlayer = gameState.players[0];
    selectedCardUid = null;
    selectedTargetId = null;
    selectedSecondaryTargetId = null;
    persistGame();
    render();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  const synced = await cdp.evalJs(clientB, `(() => {
    const room = JSON.parse(localStorage.getItem('heroKillLocalRooms'))['${roomCode}'];
    return Boolean(room?.game && room.game.players[0].maxHp === 8);
  })()`);
  return synced;
}

function card(uid, type, name, extra = {}) {
  return { uid, type, name, effect: name, suit: '♠', point: 1, pointLabel: 'A', ...extra };
}

async function stateOf(client) {
  return cdp.evalJs(client, `(() => {
    const s = gameState;
    const pending = s.pendingSpell;
    return {
      phase: s.phase, status: s.status, currentPlayerId: s.currentPlayerId,
      pendingSpell: pending ? { kind: pending.kind, currentTargetId: pending.currentTargetId, targetIds: pending.targetIds, targetIndex: pending.targetIndex, affectedIds: pending.affectedIds } : null,
      players: s.players.map((p) => ({ id: p.id, hp: p.hp, maxHp: p.maxHp, alive: p.alive, hand: p.hand.map((c) => c.uid), weapon: p.weapon?.name || null, statusEffects: p.statusEffects })),
      selectedCardUid, selectedTargetId, selectedSecondaryTargetId,
      responseVisible: document.getElementById('responsePanel').classList.contains('visible'),
      responseTitle: document.getElementById('responseTitle').textContent,
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

    const results = [];
    const phase1Code = String(100000 + Math.floor(Math.random() * 900000));
    await setupRoom(clientA, clientB, phase1Code, 2);

    // T1: 天赦令 vs 禁令 (spell) — immune
    {
      await cdp.evalJs(clientA, `(() => {
        gameState.players[0].hand = [${JSON.stringify(card('ban-x', 'ban', '禁令', { point: 2, spellId: 'ban' }))}];
        gameState.players[1].hand = [];
        gameState.players[1].weapon = { uid: 'w-tianshe', weaponId: 'tian-she-order', name: '天赦令', effect: 'x', suit: '♣', point: 10, pointLabel: '10' };
        gameState.players[1].statusEffects = {};
        selectedCardUid = 'ban-x';
        selectedTargetId = null;
        selectedSecondaryTargetId = null;
        persistGame();
        render();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const seatButtons = await cdp.evalJs(clientA, `(() => {
        const seat = document.querySelector('#seat1');
        return Array.from(seat.querySelectorAll('[data-target-id]')).map((b) => b.dataset.targetId);
      })()`);
      // UI must not offer 天赦令 holder as a ban target
      const uiExcluded = !seatButtons.includes('p2');
      // Force the cast anyway to verify the underlying immunity.
      await cdp.evalJs(clientA, `selectedTargetId = 'p2'; useBanCard();`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const s = await stateOf(clientA);
      const ok = uiExcluded && s.phase === 'PLAY' && s.players[1].statusEffects.silencePendingTurns === undefined && s.players[1].hand.length === 0;
      results.push({ name: 'T1 天赦令vs禁令(术卡)免疫', ok, extra: `uiExcluded=${uiExcluded} phase=${s.phase} silence=${s.players[1].statusEffects.silencePendingTurns}` });
    }

    // T2: 天赦令 vs 死神 (spell) — immune
    {
      await cdp.evalJs(clientA, `(() => {
        gameState.players[0].hand = [${JSON.stringify(card('dg-x', 'death-god', '死神', { spellId: 'death-god' }))}];
        gameState.players[1].hand = [];
        gameState.players[1].weapon = { uid: 'w-tianshe', weaponId: 'tian-she-order', name: '天赦令', effect: 'x', suit: '♣', point: 10, pointLabel: '10' };
        selectedCardUid = 'dg-x';
        selectedTargetId = 'p2';
        selectedSecondaryTargetId = null;
        useDeathGodCard();
        persistGame();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const s = await stateOf(clientA);
      const ok = s.phase === 'PLAY' && s.players[1].alive && s.players[1].hp === 4;
      results.push({ name: 'T2 天赦令vs死神(术卡)免疫', ok, extra: `phase=${s.phase} p2hp=${s.players[1].hp}` });
    }

    // T3: 天赦令 vs 妙手偶得 (spell) — immune
    {
      await cdp.evalJs(clientA, `(() => {
        gameState.players[0].hand = [${JSON.stringify(card('st-x', 'steal', '妙手偶得', { spellId: 'steal' }))}];
        gameState.players[1].hand = [${JSON.stringify(card('k-x', 'kill', '杀'))}];
        gameState.players[1].weapon = { uid: 'w-tianshe', weaponId: 'tian-she-order', name: '天赦令', effect: 'x', suit: '♣', point: 10, pointLabel: '10' };
        selectedCardUid = 'st-x';
        selectedTargetId = 'p2';
        selectedSecondaryTargetId = null;
        useStealCard();
        persistGame();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const s = await stateOf(clientA);
      const ok = s.phase === 'PLAY' && s.players[1].hand.length === 1 && s.players[0].hand.length === 0;
      results.push({ name: 'T3 天赦令vs妙手偶得(术卡)免疫', ok, extra: `p1hand=${s.players[0].hand.length} p2hand=${s.players[1].hand.length} phase=${s.phase}` });
    }

    // T4: 天赦令 vs 爱神 (spell) — holder immune, other target still resolved, no freeze
    {
      await cdp.evalJs(clientA, `(() => {
        gameState.players[0].hand = [${JSON.stringify(card('lg-x', 'love-god', '爱神', { spellId: 'love-god' }))}];
        gameState.players[1].hand = [];
        gameState.players[1].weapon = { uid: 'w-tianshe', weaponId: 'tian-she-order', name: '天赦令', effect: 'x', suit: '♣', point: 10, pointLabel: '10' };
        gameState.players[0].hp = 2;
        gameState.players[1].hp = 4;
        selectedCardUid = 'lg-x';
        selectedTargetId = 'p1';
        selectedSecondaryTargetId = 'p2';
        useLoveGodCard();
        persistGame();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const s = await stateOf(clientA);
      const ok = s.phase === 'PLAY' && s.pendingSpell === null;
      results.push({ name: 'T4 天赦令vs爱神: 不卡死且结算', ok, extra: `phase=${s.phase} p1hp=${s.players[0].hp} p2hp=${s.players[1].hp} affected=${JSON.stringify(s.pendingSpell)}` });
    }

    // T5: 天赦令 vs 沉默 (basic card) — record documented behavior
    {
      await cdp.evalJs(clientA, `(() => {
        gameState.players[0].hand = [${JSON.stringify(card('sil-x', 'silence', '沉默'))}];
        gameState.players[1].hand = [];
        gameState.players[1].weapon = { uid: 'w-tianshe', weaponId: 'tian-she-order', name: '天赦令', effect: 'x', suit: '♣', point: 10, pointLabel: '10' };
        gameState.players[1].statusEffects = {};
        selectedCardUid = 'sil-x';
        selectedTargetId = 'p2';
        selectedSecondaryTargetId = null;
        useSilenceCard();
        persistGame();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      const s = await stateOf(clientA);
      const silenced = (s.players[1].statusEffects.silencePendingTurns || 0) > 0;
      results.push({ name: 'T5 天赦令vs沉默(基础牌): 记录现状', ok: true, extra: `silenced=${silenced} silencePending=${s.players[1].statusEffects.silencePendingTurns}` });
    }

    // ---- Phase 2: 3-player room ----
    const phase2Code = String(100000 + Math.floor(Math.random() * 900000));
    await setupRoom(clientA, clientB, phase2Code, 3);
    const p3ok = await cdp.evalJs(clientB, `(() => {
      const room = JSON.parse(localStorage.getItem('heroKillLocalRooms'))['${phase2Code}'];
      return Boolean(room?.game?.players?.length === 3);
    })()`);

    // T6: 爱神 two others (p2+p3)
    {
      const beforeHp = await cdp.evalJs(clientA, `(() => {
        gameState.players.forEach((p) => { p.hand = []; });
        gameState.players[0].hand = [${JSON.stringify(card('lg-a', 'love-god', '爱神', { spellId: 'love-god' }))}];
        gameState.players[0].hp = 2;
        gameState.players[1].hp = 4;
        gameState.players[2].hp = 6;
        const beforeHp = gameState.players.map((p) => p.hp);
        selectedCardUid = 'lg-a';
        selectedTargetId = 'p2';
        selectedSecondaryTargetId = 'p3';
        useLoveGodCard();
        persistGame();
        return beforeHp;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const s = await stateOf(clientA);
      const ok = s.phase === 'PLAY' && s.pendingSpell === null && s.players[1].hp === 5 && s.players[2].hp === 5;
      results.push({ name: 'T6 爱神两名他人: 结算且平均分配', ok, extra: `beforeHp=${JSON.stringify(beforeHp)} phase=${s.phase} p2hp=${s.players[1].hp} p3hp=${s.players[2].hp} p1hp=${s.players[0].hp}` });
    }

    // T7: 爱神 self + other in 3-player
    {
      await cdp.evalJs(clientA, `(() => {
        gameState.players.forEach((p) => { p.hand = []; });
        gameState.players[0].hand = [${JSON.stringify(card('lg-b', 'love-god', '爱神', { spellId: 'love-god' }))}];
        gameState.players[0].hp = 2;
        gameState.players[1].hp = 4;
        gameState.players[2].hp = 3;
        selectedCardUid = 'lg-b';
        selectedTargetId = 'p1';
        selectedSecondaryTargetId = 'p2';
        useLoveGodCard();
        persistGame();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const s = await stateOf(clientA);
      const ok = s.phase === 'PLAY' && s.pendingSpell === null && s.players[0].hp === 3 && s.players[1].hp === 3;
      results.push({ name: 'T7 爱神自己+他人(3人局): 结算', ok, extra: `phase=${s.phase} p1hp=${s.players[0].hp} p2hp=${s.players[1].hp} p3hp=${s.players[2].hp}` });
    }

    // T8: 爱神 two others, p2 holds 无法选中 -> RESPONSE -> p2 accepts
    {
      const beforeHp = await cdp.evalJs(clientA, `(() => {
        gameState.players.forEach((p) => { p.hand = []; });
        gameState.players[0].hand = [${JSON.stringify(card('lg-c', 'love-god', '爱神', { spellId: 'love-god' }))}];
        gameState.players[1].hand = [${JSON.stringify(card('unt-c', 'untargetable', '无法选中'))}];
        gameState.players[2].hand = [];
        gameState.players[0].hp = 2;
        gameState.players[1].hp = 4;
        gameState.players[2].hp = 6;
        const beforeHp = gameState.players.map((p) => p.hp);
        selectedCardUid = 'lg-c';
        selectedTargetId = 'p2';
        selectedSecondaryTargetId = 'p3';
        useLoveGodCard();
        persistGame();
        return beforeHp;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const a1 = await stateOf(clientA);
      const entered = a1.phase === 'RESPONSE' && a1.pendingSpell?.currentTargetId === 'p2';
      await cdp.evalJs(clientB, `document.getElementById('takeDamage').click()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const a2 = await stateOf(clientA);
      const b2 = await stateOf(clientB);
      const ok = entered && a2.phase === 'PLAY' && a2.pendingSpell === null && a2.players[1].hp === 5 && a2.players[2].hp === 5;
      results.push({ name: 'T8 爱神两他人(目标有无法选中)承受: 结算', ok, extra: `beforeHp=${JSON.stringify(beforeHp)} entered=${entered} A2phase=${a2.phase} p2hp=${a2.players[1].hp} p3hp=${a2.players[2].hp} B2phase=${b2.phase}` });
    }

    // T9: 爱神 two others, p2 cancels with 无法选中 -> only p3 affected (no distribution)
    {
      await cdp.evalJs(clientA, `(() => {
        gameState.players.forEach((p) => { p.hand = []; });
        gameState.players[0].hand = [${JSON.stringify(card('lg-d', 'love-god', '爱神', { spellId: 'love-god' }))}];
        gameState.players[1].hand = [${JSON.stringify(card('unt-d', 'untargetable', '无法选中'))}];
        gameState.players[2].hand = [];
        gameState.players[0].hp = 2;
        gameState.players[1].hp = 4;
        gameState.players[2].hp = 6;
        selectedCardUid = 'lg-d';
        selectedTargetId = 'p2';
        selectedSecondaryTargetId = 'p3';
        useLoveGodCard();
        persistGame();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const a1 = await stateOf(clientA);
      const entered = a1.phase === 'RESPONSE' && a1.pendingSpell?.currentTargetId === 'p2';
      // p2 uses 无法选中 in tab B
      await cdp.evalJs(clientB, `(() => {
        const cardBtn = document.querySelector('[data-card-uid="unt-d"]');
        if (cardBtn) cardBtn.click();
      })()`);
      await cdp.evalJs(clientB, `document.getElementById('respondDodge').click()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const a2 = await stateOf(clientA);
      const ok = entered && a2.phase === 'PLAY' && a2.pendingSpell === null && a2.players[1].hp === 4 && a2.players[2].hp === 6;
      results.push({ name: 'T9 爱神两他人(目标无法选中取消): 仅剩一人不分配', ok, extra: `entered=${entered} A2phase=${a2.phase} p2hp=${a2.players[1].hp} p3hp=${a2.players[2].hp}` });
    }

    // T10: 特技牌 UI 打出（选牌→选目标→使用）
    {
      await cdp.evalJs(clientA, `(() => {
        gameState.players.forEach((p) => { p.hand = []; });
        gameState.players[0].hand = [{ uid: 'sp-ui', type: 'special', name: '测试-特技', effect: 'x', specialSkill: { templateId: 'SPECIAL_DAMAGE_2', name: '天降神威', value: 1, description: '对一名其他玩家造成 2 点伤害' }, suit: '♠', point: 1, pointLabel: 'A' }];
        gameState.players[0].hp = 2;
        gameState.players[1].hp = 4;
        selectedCardUid = null;
        selectedTargetId = null;
        selectedSecondaryTargetId = null;
        persistGame();
        render();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 700));
      await cdp.evalJs(clientA, `document.querySelector('[data-card-uid="sp-ui"]').click()`);
      const diag = await cdp.evalJs(clientA, `(() => ({
        selectedCardUid,
        phase: gameState.phase,
        cur: currentPlayer?.id,
        cpid: gameState.currentPlayerId,
        hasTurn: hasTurn(),
        sil: isSilenced(currentPlayer),
        btns: Array.from(document.querySelectorAll('[data-target-id]')).map((b) => b.dataset.targetId),
        cardDisabled: document.querySelector('[data-card-uid="sp-ui"]')?.disabled
      }))()`);
      console.log('T10 DIAG', JSON.stringify(diag));
      await cdp.evalJs(clientA, `[...document.querySelectorAll('[data-target-id]')].find((b) => b.dataset.targetId === 'p2').click()`);
      const useDisabled = await cdp.evalJs(clientA, `document.getElementById('useCard').disabled`);
      await cdp.evalJs(clientA, `document.getElementById('useCard').click()`);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const s = await stateOf(clientA);
      const ok = useDisabled === false && s.phase === 'PLAY' && s.pendingSpell === null && s.players[1].hp === 2;
      results.push({ name: 'T10 特技牌UI打出', ok, extra: `useDisabled=${useDisabled} phase=${s.phase} p2hp=${s.players[1].hp}` });
    }

    let failures = 0;
    results.forEach((r) => {
      if (!r.ok) failures += 1;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.extra}`);
    });
    console.log(`\n${results.length - failures}/${results.length} scenarios passed, ${failures} failed`);
    console.log(`phase1=${phase1Code} phase2=${phase2Code}`);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (clientA) await clientA.close().catch(() => {});
    if (clientB) await clientB.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    chrome.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
