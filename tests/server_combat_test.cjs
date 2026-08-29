'use strict';
const { createSession } = require('../server-game.cjs');

function hero(id, name) {
  return {
    id: `${id}-h`, heroName: name, title: `${name}传`, flavorText: '测试', maxHp: 7,
    primarySkill: { templateId: 'EXTRA_DRAW', name: `${name}灵感`, value: 1, trigger: 'DRAW_PHASE', description: 'd', power: 2 },
    secondarySkill: { templateId: 'DODGE_AS_HEAL', name: `${name}身法`, value: 1, trigger: 'PLAY_PHASE', description: 'd', power: 3 },
    specialSkill: { templateId: 'SPECIAL_DRAW_2', name: `${name}妙手`, value: 1, trigger: 'SPECIAL_CARD', description: 'd', power: 3 }
  };
}

function makeRoom() {
  const players = ['p1', 'p2', 'p3', 'p4'].map((id, index) => ({ id, nickname: `玩家${index + 1}`, role: index === 0 ? 'host' : 'player' }));
  const finalHeroes = {};
  players.forEach((p) => { finalHeroes[p.id] = hero(p.id, p.nickname); });
  const specialCards = players.map((p, index) => ({
    uid: `special-${index + 1}`, type: 'special', name: `${finalHeroes[p.id].heroName}--sp`, effect: 'd',
    specialSkill: finalHeroes[p.id].specialSkill, heroName: finalHeroes[p.id].heroName
  }));
  return {
    roomCode: '123456', phase: 'PLAYING', revision: 1, mode: 'free', duration: 0, schemaVersion: 1,
    createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now(),
    heroGeneration: { status: 'READY' }, players, finalHeroes, specialCards
  };
}

function q(v) { return JSON.stringify(String(v || '')); }

let pass = 0; let fail = 0;
function check(name, cond) { if (cond) { pass += 1; console.log('PASS', name); } else { fail += 1; console.log('FAIL', name); } }

const session = createSession(makeRoom());
const ev = session.eval;

// 进入出牌阶段
ev('gameState.drawDeadline = Date.now() - 1;');
session.tick();
check('reached PLAY', ev('gameState.phase') === 'PLAY');

const curId = ev('gameState.currentPlayerId');
// 找当前玩家的相邻存活目标
const targetId = ev(`(() => { const c = gameState.players.find(p => p.id === gameState.currentPlayerId); return (gameState.players.find(p => p.alive && p.id !== c.id && areAdjacent(c.id, p.id)) || {}).id || null; })()`);
check('there is an adjacent target', Boolean(targetId));

// canAct 校验：轮到的玩家可行动，其他人不可
check('canAct(current) true', session.canAct(curId));
const otherId = ev(`gameState.players.find(p => p.id !== ${q(curId)}).id`);
check('canAct(other) false', !session.canAct(otherId));

// --- 出杀（目标无闪 -> 直接掉血）---
ev(`const __c = gameState.players.find(p=>p.id===${q(curId)}); __c.hand = __c.hand.filter(c=>c.type!=='kill'); __c.hand.push({uid:'k1', type:'kill', name:'杀', effect:'x'}); __c.skillUsage = {}; gameState.killUsed = false;`);
ev(`const __t = gameState.players.find(p=>p.id===${q(targetId)}); __t.hand = []; __t.hp = __t.maxHp;`);
const tMaxHp = ev(`gameState.players.find(p=>p.id===${q(targetId)}).maxHp`);
session.act({ type: 'play', playerId: curId, cardUid: 'k1', targetId });
const tHpAfterKill = ev(`gameState.players.find(p=>p.id===${q(targetId)}).hp`);
check('kill dealt damage', tHpAfterKill === tMaxHp - 1);
check('phase back to PLAY after kill', ev('gameState.phase') === 'PLAY');

// --- 出杀（目标有闪 -> 响应阶段 -> 闪规避伤害）---
ev('gameState.killUsed = false;');
ev(`__c.hand = __c.hand.filter(c=>c.type!=='kill'); __c.hand.push({uid:'k2', type:'kill', name:'杀', effect:'x'});`);
ev(`__t.hand = [{uid:'dg1', type:'dodge', name:'闪', effect:'x'}]; __t.hp = __t.maxHp;`);
session.act({ type: 'play', playerId: curId, cardUid: 'k2', targetId });
check('kill puts target in RESPONSE', ev('gameState.phase') === 'RESPONSE');
session.act({ type: 'dodge', playerId: targetId });
const tHpAfterDodge = ev(`gameState.players.find(p=>p.id===${q(targetId)}).hp`);
check('dodge avoids damage', tHpAfterDodge === tMaxHp);

// --- 出杀（目标有闪但不闪 -> 承受伤害）---
ev('gameState.killUsed = false;');
ev(`__c.hand = __c.hand.filter(c=>c.type!=='kill'); __c.hand.push({uid:'k3', type:'kill', name:'杀', effect:'x'});`);
ev(`__t.hand = [{uid:'dg2', type:'dodge', name:'闪', effect:'x'}]; __t.hp = __t.maxHp;`);
session.act({ type: 'play', playerId: curId, cardUid: 'k3', targetId });
check('kill again puts target in RESPONSE', ev('gameState.phase') === 'RESPONSE');
session.act({ type: 'take-damage', playerId: targetId });
const tHpAfterHit = ev(`gameState.players.find(p=>p.id===${q(targetId)}).hp`);
check('take-damage applies damage', tHpAfterHit === tMaxHp - 1);

// --- 使用奶治疗 ---
ev(`__c.hp = __c.maxHp - 2; __c.hand = __c.hand.filter(c=>c.type!=='heal'); __c.hand.push({uid:'h1', type:'heal', name:'奶', effect:'x'});`);
session.act({ type: 'play', playerId: curId, cardUid: 'h1' });
const cHpAfterHeal = ev(`gameState.players.find(p=>p.id===${q(curId)}).hp`);
check('heal restores hp', cHpAfterHeal === (ev(`gameState.players.find(p=>p.id===${q(curId)}).maxHp`) - 1));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
