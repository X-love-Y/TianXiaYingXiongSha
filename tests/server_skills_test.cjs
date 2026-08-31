'use strict';
// 新增技能结算验证：SLASH_RANGE / SLASH_IGNORE_SHIELD / SLASH_STEAL / REVENGE_DISCARD / LAST_STAND
// 以及 SPECIAL_DRAW_DISCARD / SPECIAL_STEAL_EQUIP / SPECIAL_HEAL_DRAW。
// 每个场景使用独立 session，隔离 pending 状态，避免相互干扰。
const { createSession } = require('../server-game.cjs');

function sk(id, name, value = 1) {
  return { templateId: id, name, value };
}
function hero(id, name, primaryId, secondaryId, specialId) {
  return {
    id: `${id}-h`, heroName: name, title: `${name}传`, flavorText: '测试', maxHp: 7,
    primarySkill: { ...sk(primaryId, `${name}主技`), trigger: 'PLAY_PHASE', description: 'x', power: 4 },
    secondarySkill: { ...sk(secondaryId, `${name}副技`), trigger: 'PLAY_PHASE', description: 'x', power: 3 },
    specialSkill: { ...sk(specialId, `${name}特技`), trigger: 'SPECIAL_CARD', description: 'x', power: 4 }
  };
}
function makeRoom() {
  const players = ['p1', 'p2', 'p3', 'p4'].map((id, index) => ({ id, nickname: `玩家${index + 1}`, role: index === 0 ? 'host' : 'player' }));
  const finalHeroes = {};
  finalHeroes.p1 = hero('p1', '远程', 'SLASH_RANGE', 'DODGE_DRAW', 'SPECIAL_DRAW_DISCARD');
  finalHeroes.p2 = hero('p2', '破盾', 'SLASH_IGNORE_SHIELD', 'DODGE_AS_HEAL', 'SPECIAL_STEAL_EQUIP');
  finalHeroes.p3 = hero('p3', '神偷', 'SLASH_STEAL', 'EXTRA_DRAW', 'SPECIAL_HEAL_DRAW');
  finalHeroes.p4 = hero('p4', '反击', 'REVENGE_DISCARD', 'DAMAGE_DRAW', 'SPECIAL_DAMAGE_2');
  const specialCards = players.map((p, index) => ({
    uid: `special-${index + 1}`, type: 'special', name: `${finalHeroes[p.id].heroName}--${finalHeroes[p.id].specialSkill.name}`,
    effect: finalHeroes[p.id].specialSkill.description, specialSkill: finalHeroes[p.id].specialSkill, heroName: finalHeroes[p.id].heroName
  }));
  return {
    roomCode: '654321', phase: 'PLAYING', revision: 1, mode: 'free', duration: 0, schemaVersion: 1,
    createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now(), heroGeneration: { status: 'READY' },
    players, finalHeroes, specialCards
  };
}
function q(v) { return JSON.stringify(String(v || '')); }
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass += 1; console.log('PASS', name); } else { fail += 1; console.log('FAIL', name); } }
function newSession() {
  const s = createSession(makeRoom());
  const ev = s.eval;
  ev('gameState.currentPlayerId = "p1"; gameState.phase = "PLAY"; gameState.killUsed = false; gameState.pendingAttack = null; gameState.pendingRescue = null; gameState.pendingSpell = null; gameState.round = 1;');
  return { ev, act: (type, pid, extra = {}) => s.act({ type, playerId: pid, ...extra }) };
}
function setHand(ev, pid, cards) {
  ev(`(() => { const h = [${cards.map((c) => `{uid:${q(c.uid)},type:${q(c.type)},name:${q(c.name)},effect:"x"${c.specialSkill ? `,specialSkill:${JSON.stringify(c.specialSkill)}` : ''}}`).join(',')}]; const p = gameState.players.find(x => x.id === ${q(pid)}); p.hand = h; })();`);
}
function resetTurn(ev, pid) {
  ev(`gameState.currentPlayerId = ${q(pid)}; gameState.phase = "PLAY"; gameState.killUsed = false; gameState.pendingAttack = null; gameState.pendingRescue = null; gameState.pendingSpell = null; selectedCardUid = null; selectedTargetId = null; selectedSecondaryTargetId = null;`);
  ev(`currentPlayer = gameState.players.find(x => x.id === ${q(pid)});`);
}

// ---- LAST_STAND：p4 掉 2 血（7->5），应回 2 至 7 ----
{
  const { ev } = newSession();
  ev('const p = gameState.players.find(x => x.id === "p4"); p.hp = 7; p.maxHp = 7; p.skillUsage = {}; p.hero.primarySkill = Object.assign(p.hero.primarySkill, { templateId: "LAST_STAND", name: "背水" });');
  ev('loseHp(gameState.players.find(x => x.id === "p4"), 2, "测试", null);');
  check('LAST_STAND：7-2=5 后触发恢复 2 点，回到 7', ev('gameState.players.find(x => x.id === "p4").hp') === 7);
  ev('loseHp(gameState.players.find(x => x.id === "p4"), 1, "测试", null);');
  check('LAST_STAND：仅本局首次生效，第二次不再额外回血', ev('gameState.players.find(x => x.id === "p4").hp') === 6);
}

// ---- SLASH_RANGE：p1 跨距离杀 p3 合法 ----
{
  const { ev } = newSession();
  resetTurn(ev, 'p1');
  setHand(ev, 'p1', [{ uid: 'k1', type: 'kill', name: '杀' }]);
  setHand(ev, 'p3', [{ uid: 'd3', type: 'dodge', name: '闪' }]);
  ev('selectedCardUid = "k1"; selectedTargetId = "p3";');
  ev('playKill(gameState.players.find(x => x.id === "p1"));');
  check('SLASH_RANGE：跨距离杀进入响应阶段', ev('gameState.pendingAttack && gameState.pendingAttack.targetId === "p3"'));
  ev('resolveAttack(false);');
  check('SLASH_RANGE：命中对端 p3 掉 1 血', ev('gameState.players.find(x => x.id === "p3").hp') === 6);
}

// ---- SLASH_IGNORE_SHIELD：p2 杀带奇盾的 p1，无视免伤 ----
{
  const { ev } = newSession();
  resetTurn(ev, 'p2');
  setHand(ev, 'p2', [{ uid: 'k2', type: 'kill', name: '杀' }]);
  setHand(ev, 'p1', [{ uid: 'h1', type: 'heal', name: '奶' }]);
  ev('gameState.players.find(x => x.id === "p1").weapon = { weaponId: "qi-shield", name: "奇盾", effect: "x" }; gameState.players.find(x => x.id === "p1").weaponUsage = {}; gameState.players.find(x => x.id === "p1").skillUsage = {};');
  ev('selectedCardUid = "k2"; selectedTargetId = "p1";');
  ev('playKill(gameState.players.find(x => x.id === "p2"));');
  ev('resolveAttack(false);');
  check('SLASH_IGNORE_SHIELD：奇盾被无视，p1 掉 1 血', ev('gameState.players.find(x => x.id === "p1").hp') === 6);
}

// ---- SLASH_STEAL：p3 杀 p4 命中后偷 p4 一张手牌 ----
{
  const { ev } = newSession();
  resetTurn(ev, 'p3');
  setHand(ev, 'p3', [{ uid: 'k3', type: 'kill', name: '杀' }]);
  setHand(ev, 'p4', [{ uid: 'x1', type: 'heal', name: '奶' }, { uid: 'x2', type: 'kill', name: '杀' }]);
  ev('const a = gameState.players.find(x => x.id === "p3"); a.skillUsage = {};');
  ev('const t = gameState.players.find(x => x.id === "p4"); t.skillUsage = {}; t.hp = 7; t.maxHp = 7;');
  ev('gameState.pendingAttack = { attackerId: "p3", targetId: "p4", targetIds: ["p4"], resolvedTargetIds: [], cardUid: "k3", damageTransferred: false }; gameState.phase = "RESPONSE";');
  ev('resolveAttack(false);');
  check('SLASH_STEAL：p3 命中后手牌数量 +1（偷一张）', ev('gameState.players.find(x => x.id === "p3").hand.length') === 1);
}

// ---- REVENGE_DISCARD：p4 受 p3 伤害后弃 p3 一张手牌 ----
{
  const { ev } = newSession();
  resetTurn(ev, 'p3');
  setHand(ev, 'p3', [{ uid: 'k3b', type: 'kill', name: '杀' }, { uid: 'keep', type: 'heal', name: '奶' }]);
  setHand(ev, 'p4', [{ uid: 'x1b', type: 'kill', name: '杀' }]);
  ev('const a = gameState.players.find(x => x.id === "p3"); a.skillUsage = {};');
  ev('const t = gameState.players.find(x => x.id === "p4"); t.skillUsage = {}; t.hp = 7; t.maxHp = 7;');
  ev('selectedCardUid = "k3b"; selectedTargetId = "p4";');
  ev('playKill(gameState.players.find(x => x.id === "p3"));');
  ev('resolveAttack(false);');
  check('REVENGE_DISCARD：p4 受伤后 p3 手牌被弃（剩 0 或受减）', ev('gameState.players.find(x => x.id === "p3").hand.length') < 2);
  check('REVENGE_DISCARD：p4 标记已触发', typeof ev('gameState.players.find(x => x.id === "p4").skillUsage.revengeDiscardRound') === 'number');
}

// ---- 特技：SPECIAL_DRAW_DISCARD（摸 2 弃 1，净增 1）----
{
  const { ev } = newSession();
  resetTurn(ev, 'p1');
  setHand(ev, 'p1', [{ uid: 'sp1', type: 'special', name: '取舍', effect: 'x', specialSkill: { templateId: 'SPECIAL_DRAW_DISCARD', name: '取舍之道', value: 1 } }]);
  ev('gameState.deck = [{uid:"z1",type:"heal",name:"奶",effect:"x"},{uid:"z2",type:"dodge",name:"闪",effect:"x"},{uid:"z3",type:"kill",name:"杀",effect:"x"}];');
  const before = ev('gameState.players.find(x => x.id === "p1").hand.length');
  ev('selectedCardUid = "sp1"; useSpecialCard(gameState.players.find(x => x.id === "p1"));');
  check('SPECIAL_DRAW_DISCARD：先弃1再摸2弃1，净变化 0', ev('gameState.players.find(x => x.id === "p1").hand.length') === before);
}

// ---- 特技：SPECIAL_STEAL_EQUIP（p2 夺得 p1 装备并装备）----
{
  const { ev } = newSession();
  resetTurn(ev, 'p2');
  setHand(ev, 'p2', [{ uid: 'sp2', type: 'special', name: '夺宝', effect: 'x', specialSkill: { templateId: 'SPECIAL_STEAL_EQUIP', name: '夺宝奇兵', value: 1 } }]);
  ev('gameState.players.find(x => x.id === "p1").weapon = { weaponId: "xuan", name: "轩辕剑", effect: "x" }; gameState.players.find(x => x.id === "p2").weapon = null;');

  ev('selectedCardUid = "sp2"; selectedTargetId = "p1"; useSpecialCard(gameState.players.find(x => x.id === "p2"));');
  check('SPECIAL_STEAL_EQUIP：p2 获得轩辕剑', ev('gameState.players.find(x => x.id === "p2").weapon && gameState.players.find(x => x.id === "p2").weapon.weaponId === "xuan"'));
  check('SPECIAL_STEAL_EQUIP：p1 失去装备', ev('gameState.players.find(x => x.id === "p1").weapon === null'));
}

// ---- 特技：SPECIAL_HEAL_DRAW（回 1 摸 2）----
{
  const { ev } = newSession();
  resetTurn(ev, 'p3');
  setHand(ev, 'p3', [{ uid: 'sp3', type: 'special', name: '回春', effect: 'x', specialSkill: { templateId: 'SPECIAL_HEAL_DRAW', name: '起死回生', value: 1 } }]);
  ev('gameState.deck = [{uid:"z4",type:"heal",name:"奶",effect:"x"},{uid:"z5",type:"dodge",name:"闪",effect:"x"}];');
  ev('const p = gameState.players.find(x => x.id === "p3"); p.hp = 5; p.maxHp = 7;');
  const before = ev('gameState.players.find(x => x.id === "p3").hand.length');
  ev('selectedCardUid = "sp3"; useSpecialCard(gameState.players.find(x => x.id === "p3"));');
  check('SPECIAL_HEAL_DRAW：p3 恢复 1 点生命', ev('gameState.players.find(x => x.id === "p3").hp') === 6);
  check('SPECIAL_HEAL_DRAW：p3 摸 2 张牌（净 +1）', ev('gameState.players.find(x => x.id === "p3").hand.length') === before + 1);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
