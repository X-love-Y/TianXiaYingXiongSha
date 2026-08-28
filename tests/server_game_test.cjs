'use strict';
const { createSession } = require('../server-game.cjs');

function hero(id, name) {
  return {
    id: `${id}-h`,
    heroName: name,
    title: `${name}传`,
    flavorText: '测试',
    maxHp: 7,
    primarySkill: { templateId: 'EXTRA_DRAW', name: `${name}灵感`, value: 1, trigger: 'DRAW_PHASE', description: '摸牌阶段额外摸1张', power: 2 },
    secondarySkill: { templateId: 'DODGE_AS_HEAL', name: `${name}身法`, value: 1, trigger: 'PLAY_PHASE', description: '闪转奶', power: 3 },
    specialSkill: { templateId: 'SPECIAL_DRAW_2', name: `${name}妙手`, value: 1, trigger: 'SPECIAL_CARD', description: '摸2张', power: 3 }
  };
}

function makeRoom() {
  const players = ['p1', 'p2', 'p3', 'p4'].map((id, index) => ({ id, nickname: `玩家${index + 1}`, role: index === 0 ? 'host' : 'player' }));
  const finalHeroes = {};
  players.forEach((p) => { finalHeroes[p.id] = hero(p.id, p.nickname); });
  const specialCards = players.map((p, index) => ({
    uid: `special-${index + 1}`,
    type: 'special',
    name: `${finalHeroes[p.id].heroName}--${finalHeroes[p.id].specialSkill.name}`,
    effect: finalHeroes[p.id].specialSkill.description,
    specialSkill: finalHeroes[p.id].specialSkill,
    heroName: finalHeroes[p.id].heroName
  }));
  return {
    roomCode: '123456',
    phase: 'PLAYING',
    revision: 1,
    mode: 'free',
    duration: 0,
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now(),
    heroGeneration: { status: 'READY' },
    players,
    finalHeroes,
    specialCards
  };
}

function q(v) { return JSON.stringify(String(v || '')); }

let pass = 0;
let fail = 0;
function check(name, cond) { if (cond) { pass += 1; console.log('PASS', name); } else { fail += 1; console.log('FAIL', name); } }

const session = createSession(makeRoom());
const ev = session.eval;

check('gameState created PLAYING', ev('gameState && gameState.status === "PLAYING"'));
check('has 4 players', ev('gameState.players.length') === 4);
check('players have hands', ev('gameState.players.every(p => p.hand.length >= 3)'));

const first = ev('gameState.currentPlayerId');
console.log('first turn player:', first, 'phase:', ev('gameState.phase'));

// 推进：把摸牌倒计时设为过去，tick 进入出牌阶段
ev('gameState.drawDeadline = Date.now() - 1;');
session.tick();
check('draw resolves to PLAY', ev('gameState.phase') === 'PLAY');

// 当前玩家过牌，应轮到下一个玩家
const firstIdx = ev('gameState.players.findIndex(p => p.id === gameState.currentPlayerId)');
const before = ev('gameState.currentPlayerId');
ev('gameState.players.find(p => p.id === gameState.currentPlayerId);');
session.act({ type: 'pass', playerId: before });
const after = ev('gameState.currentPlayerId');
check('pass advances to next player', after !== before);
check('next player phase DRAWING', ev('gameState.phase') === 'DRAWING');

// 再推进一轮，验证能 4 玩家循环
const order = [before, after];
let cur = after;
for (let i = 0; i < 3; i += 1) {
  ev('gameState.drawDeadline = Date.now() - 1;');
  session.tick();
  check(`turn ${i + 2} resolves to PLAY`, ev('gameState.phase') === 'PLAY');
  cur = ev('gameState.currentPlayerId');
  session.act({ type: 'pass', playerId: cur });
  order.push(ev('gameState.currentPlayerId'));
}
console.log('turn order sample:', order.join(' -> '));
check('cycles through all 4 players', new Set(order).size >= 4);

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
