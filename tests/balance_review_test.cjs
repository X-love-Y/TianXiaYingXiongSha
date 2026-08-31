'use strict';
// 全局平衡复核验证：同角色过度集中被降级、单卡不产生重复、强度溢出被记录。
const g = require('../hero-generator.cjs');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass += 1; console.log('PASS', name); } else { fail += 1; console.log('FAIL', name); } }

function mk(primary, secondary, special, name) {
  return {
    heroName: name || '测试', description: name || '测试', maxHp: 7,
    primarySkill: { templateId: primary, name: primary + '主', value: 1, trigger: 'x', description: 'd', power: 4 },
    secondarySkill: { templateId: secondary, name: secondary + '副', value: 1, trigger: 'x', description: 'd', power: 3 },
    specialSkill: { templateId: special, name: special + '特', value: 1, trigger: 'SPECIAL_CARD', description: 'd', power: 3 }
  };
}

// 场景 1：4 张卡主技能全是 UNLIMITED_SLASH（阈值 2），复核后应降到 ≤2。
{
  const gen = { p1: [mk('UNLIMITED_SLASH', 'EXTRA_DRAW', 'SPECIAL_DAMAGE_2'), mk('UNLIMITED_SLASH', 'DODGE_AS_HEAL', 'SPECIAL_DRAW_2'), mk('UNLIMITED_SLASH', 'HEAL_PLUS', 'SPECIAL_HEAL_2')], p2: [mk('UNLIMITED_SLASH', 'DAMAGE_DRAW', 'SPECIAL_STEAL_CARD')] };
  const r = g.reviewRoomBalance(gen, { maxRoleDupes: 2 });
  const count = Object.values(r.heroes).flat().filter((h) => h.primarySkill.templateId === 'UNLIMITED_SLASH').length;
  check('主技能过度集中被降到阈值(≤2)', count <= 2);
  check('修复动作发生(>0)', r.report.repaired > 0);
  let withinCardDup = 0;
  Object.values(r.heroes).flat().forEach((h) => {
    const ids = [h.primarySkill.templateId, h.secondarySkill.templateId, h.specialSkill.templateId];
    if (new Set(ids).size !== 3) withinCardDup += 1;
  });
  check('修复后无单卡技能重复', withinCardDup === 0);
}

// 场景 2：本来就不重复，复核不应无谓改动。
{
  const gen = { p1: [mk('UNLIMITED_SLASH', 'EXTRA_DRAW', 'SPECIAL_DAMAGE_2'), mk('SLASH_RANGE', 'DODGE_AS_HEAL', 'SPECIAL_DRAW_2'), mk('SLASH_STEAL', 'HEAL_PLUS', 'SPECIAL_HEAL_2')], p2: [mk('SLASH_IGNORE_SHIELD', 'DAMAGE_DRAW', 'SPECIAL_STEAL_CARD')] };
  const r = g.reviewRoomBalance(gen, { maxRoleDupes: 2 });
  check('无过度集中时不改动', r.report.repaired === 0);
}

// 场景 3：异常强度溢出被记录（主+副+特 超出上限）。
{
  const gen = { p1: [mk('SLASH_DAMAGE_UP', 'SLASH_DRAW', 'SPECIAL_DAMAGE_2')] };
  gen.p1[0].primarySkill.power = 5;
  gen.p1[0].secondarySkill.power = 4;
  gen.p1[0].specialSkill.power = 5;
  const r = g.reviewRoomBalance(gen, { maxRoleDupes: 2 });
  check('强度溢出被记录', r.report.overflow.length >= 1);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
