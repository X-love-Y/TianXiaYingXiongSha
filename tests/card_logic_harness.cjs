'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'game.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const matches = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/g)];
  let gameScript = matches[matches.length - 1][1];
  // Optionally remove the automatic tryStartGame() at the end of the init block.
  const autoStartIndex = gameScript.lastIndexOf('tryStartGame();');
  const strippedScript = autoStartIndex >= 0
    ? gameScript.slice(0, autoStartIndex) + gameScript.slice(autoStartIndex + 'tryStartGame();'.length)
    : gameScript;

const roomStorageKey = 'heroKillLocalRooms';
const sessionStorageKey = 'heroKillRoomSession';

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((n) => this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  toggle(name, force) {
    if (force === undefined) {
      if (this.set.has(name)) { this.set.delete(name); return false; }
      this.set.add(name); return true;
    }
    if (force) this.set.add(name); else this.set.delete(name);
    return Boolean(force);
  }
  contains(name) { return this.set.has(name); }
}
class FakeStyle { setProperty() {} }
class FakeElement {
  constructor(id) {
    this.id = id;
    this.classList = new FakeClassList();
    this.style = new FakeStyle();
    this.dataset = {};
    this.children = [];
    this._innerHTML = '';
    this.disabled = false;
    this.open = false;
    this.textContent = '';
    this.value = '';
    this.currentTime = 0;
    this.offsetWidth = 0;
    this.handlers = {};
  }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v) { this._innerHTML = v; }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  play() { return Promise.resolve(); }
  click() {}
}

function makeSandbox(room, session, timers, localStore, sessionStore, net) {
  const elements = new Map();
  const makeEl = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };
  const storageListeners = [];
  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    // 该 harness 模拟“对局引擎”，与服务器复用的引擎一致（SERVER_AUTH=false），
    // 避免客户端瘦身（SERVER_AUTH=true）导致动作被重定向到不存在的 fetch。
    __SERVER_AUTH: false,
    Object,
    Array,
    Map,
    Set,
    Promise,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    setTimeout: (fn, ms = 0) => {
      const id = ++timers.seq;
      timers.items.set(id, { fn, ms, interval: false, at: timers.now + ms, order: timers.order++ });
      return id;
    },
    setInterval: (fn, ms = 0) => {
      const id = ++timers.seq;
      timers.items.set(id, { fn, ms, interval: true, at: timers.now + ms, order: timers.order++ });
      return id;
    },
    clearTimeout: (id) => timers.items.delete(id),
    clearInterval: (id) => timers.items.delete(id),
    localStorage: {
      getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
      setItem: (k, v) => localStore.set(k, String(v)),
      removeItem: (k) => localStore.delete(k)
    },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => sessionStore.set(k, String(v)),
      removeItem: (k) => sessionStore.delete(k)
    },
    document: {
      getElementById: (id) => makeEl(id),
      querySelector: () => makeEl('__query__'),
      addEventListener: () => {}
    },
    window: {
      addEventListener: (type, fn) => storageListeners.push({ type, fn }),
      location: { href: '', replace: () => {} },
      EventSource: class {
        constructor() {}
        close() {}
        addEventListener() {}
      },
      HeroKillNet: net || undefined
    },
    location: { href: '' },
    StorageEvent: class {
      constructor(type, init) { this.key = init ? init.key : null; }
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ rooms: {} }) })
  };
  const ctx = vm.createContext(sandbox);
  return {
    ctx,
    storageListeners,
    makeEl,
    dispatchStorage() {
      storageListeners.forEach(({ fn }) => fn(new (sandbox.StorageEvent)('storage', { key: roomStorageKey })));
    }
  };
}

function makeRoom(players, extra = {}) {
  const now = 1750000000000;
  return {
    roomCode: '123456',
    revision: 1,
    phase: 'PLAYING',
    mode: 'survival',
    players,
    heroGeneration: { status: 'READY' },
    generatedHeroes: Object.fromEntries(players.map((p) => [p.id, { heroName: p.nickname + '的英雄', maxHpBonus: 0 }])),
    startedAt: now,
    ...extra
  };
}

// Run one context with a given room + session. Returns handles to drive the game.
function bootClient(room, playerId, timers, net, autoStart = true) {
  const localStore = new Map();
  const sessionStore = new Map();
  localStore.set(roomStorageKey, JSON.stringify({ '123456': room }));
  sessionStore.set(sessionStorageKey, JSON.stringify({ roomCode: '123456', playerId }));
  const sb = makeSandbox(room, { roomCode: '123456', playerId }, timers, localStore, sessionStore, net);
  vm.runInContext(autoStart ? gameScript : strippedScript, sb.ctx, { filename: 'game.html' });
  return {
    sb,
    localStore,
    get gameState() { return vm.runInContext('gameState', sb.ctx); },
    set gameState(v) { vm.runInContext('gameState = arguments[0]', sb.ctx, { filename: 'set.js' })(v); },
    eval(code) { return vm.runInContext(code, sb.ctx, { filename: 'eval.js' }); }
  };
}

// ---------------------------------------------------------------------------
// Results collection
// ---------------------------------------------------------------------------
const results = [];
function record(name, ok, extra = '') { results.push({ name, ok: Boolean(ok), extra: String(extra) }); }
function assert(name, cond, extra = '') { record(name, cond, extra); }
function assertEq(name, actual, expected) {
  record(name, JSON.stringify(actual) === JSON.stringify(expected), `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// Server authorization logic (copied from dev-server.cjs for offline testing)
// ---------------------------------------------------------------------------
function gameMutationAllowed(currentRoom, nextRoom, actorPlayerId) {
  const previousGame = currentRoom?.game;
  const nextGame = nextRoom?.game;
  if (JSON.stringify(previousGame || null) === JSON.stringify(nextGame || null)) return true;
  const players = currentRoom?.players || [];
  const actor = players.find((player) => player.id === actorPlayerId);
  if (!actor) return false;
  if (!previousGame) {
    const hostId = players.find((player) => player.role === 'host')?.id || players[0]?.id;
    return actorPlayerId === hostId;
  }
  const expectedPlayerId = previousGame.phase === 'RESPONSE'
    ? (previousGame.pendingAttack?.targetId || previousGame.pendingSpell?.currentTargetId)
    : previousGame.phase === 'DYING'
      ? previousGame.pendingRescue?.targetId
      : previousGame.phase === 'DRAWING'
        ? previousGame.drawPlayerId
        : previousGame.currentPlayerId;
  const expectedIsRealPlayer = players.some((player) => player.id === expectedPlayerId);
  if (expectedIsRealPlayer) {
    if (actorPlayerId === expectedPlayerId) return true;
    const now = Date.now();
    const deadline = previousGame.phase === 'RESPONSE' || previousGame.phase === 'DYING'
      ? previousGame.responseDeadline
      : previousGame.phase === 'DRAWING'
        ? previousGame.drawDeadline
        : previousGame.turnDeadline;
    if (deadline && now > deadline) {
      const hostId = players.find((player) => player.role === 'host')?.id || players[0]?.id;
      return actorPlayerId === hostId;
    }
    return false;
  }
  const hostId = players.find((player) => player.role === 'host')?.id || players[0]?.id;
  return actorPlayerId === hostId;
}

// ---------------------------------------------------------------------------
// Section 1: single-context card logic tests
// ---------------------------------------------------------------------------
{
  const timers = { seq: 0, order: 0, now: 1750000000000, items: new Map() };
  const players = [
    { id: 'p1', nickname: '玩家一', role: 'host' },
    { id: 'p2', nickname: '玩家二', role: 'player' }
  ];
  const room = makeRoom(players);
  const client = bootClient(room, 'p1', timers, null);
  client.eval('const p1 = gameState.players[0]; const p2 = gameState.players[1];');
  const C = client.eval(`(() => {
    const results = [];
    return {
      gameState, currentPlayer, selectedCardUid, selectedTargetId, selectedSecondaryTargetId,
      useStealCard, useBanCard, useDeathGodCard, useLoveGodCard, useMaoshengCard,
      useDivinePunishCard, useJudgmentCard, useDoomCard, useHealCard, useSilenceCard,
      playKill, equipCard, useUntargetableForSpell, acceptSpellEffect, resolveAttack,
      resolveDying, directPass, nextTurn, rotateActiveJudgments, randomDiscardAndEnd,
      spendCard, drawCards, finishDefeat, canUseDoom, isSpellImmune, beginDying,
      activateSilenceIfNeeded, discardJudgmentCard, hasEquipment, areAdjacent,
      TURN_MS, DRAW_MS, RESPONSE_MS, MAX_HAND, MAX_HP,
      WEAPON_CARDS, SPELL_CARDS, JUDGMENT_CARDS
    };
  })()`);
  const gs = () => client.eval('gameState');
  const p1 = () => client.eval('gameState.players[0]');
  const p2 = () => client.eval('gameState.players[1]');
  const set = (code) => client.eval(code);
  const card = (uid, type, name, extra = {}) => ({ uid, type, name, effect: name, suit: '♠', point: 1, pointLabel: 'A', ...extra });

  function resetScenario() {
    client.eval(`(() => {
      gameState.status = 'PLAYING';
      gameState.phase = 'PLAY';
      gameState.currentPlayerId = gameState.players[0].id;
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
      gameState.discardPile = [];
      gameState.deck = [];
      gameState.players = [p1, p2];
      gameState.players.forEach((player) => {
        player.alive = true;
        player.hp = player.maxHp;
        player.hand = [];
        player.weapon = null;
        player.weaponUsage = {};
        player.statusEffects = {};
        player.skillUsage = {};
      });
      currentPlayer = gameState.players[0];
      selectedCardUid = null;
      selectedTargetId = null;
      selectedSecondaryTargetId = null;
      selectedDiscardUids = new Set();
    })()`);
  }

  // ---- 妙手偶得 ----
  resetScenario();
  {
    const steal = card('steal-t1', 'steal', '妙手偶得');
    set(`p1.hand.push(${JSON.stringify(steal)}); p2.hand = [${JSON.stringify(card('k1','kill','杀'))}, ${JSON.stringify(card('d1','dodge','闪'))}, ${JSON.stringify(card('h1','heal','奶'))}]; selectedCardUid = 'steal-t1'; selectedTargetId = p2.id;`);
    set('useStealCard()');
    const s = gs();
    assert('steal: 手牌分支成功结算', s.phase === 'PLAY' && s.pendingSpell === null, `phase=${s.phase}`);
    assert('steal: 目标减少一张手牌', p2().hand.length === 2);
    assert('steal: 使用者获得一张手牌', p1().hand.length === 1 && p1().hand[0].uid.startsWith('k') || p1().hand[0].uid.startsWith('d') || p1().hand[0].uid.startsWith('h'));
    assert('steal: 牌已进入弃牌堆', s.discardPile.some((c) => c.uid === 'steal-t1'));
  }

  resetScenario();
  {
    const steal = card('steal-t2', 'steal', '妙手偶得');
    set(`p1.hand.push(${JSON.stringify(steal)}); p2.hand = []; p2.weapon = ${JSON.stringify({ weaponId: 'hard-bow', name: '硬弓', effect: 'x' })}; selectedCardUid = 'steal-t2'; selectedTargetId = p2.id;`);
    set('useStealCard()');
    const s = gs();
    assert('steal: 装备分支成功结算', s.phase === 'PLAY' && s.pendingSpell === null);
    assert('steal: 目标装备被夺', p2().weapon === null);
    assert('steal: 使用者装备硬弓', p1().weapon?.name === '硬弓');
  }

  resetScenario();
  {
    const steal = card('steal-t3', 'steal', '妙手偶得');
    set(`p1.hand.push(${JSON.stringify(steal)}); p1.weapon = ${JSON.stringify({ weaponId: 'rapid-crossbow', name: '连射弩箭', effect: 'x' })}; p2.hand = []; p2.weapon = ${JSON.stringify({ weaponId: 'qi-shield', name: '奇盾', effect: 'x' })}; selectedCardUid = 'steal-t3'; selectedTargetId = p2.id;`);
    set('useStealCard()');
    const s = gs();
    assert('steal: 替换装备后原装备入弃牌堆', s.discardPile.some((c) => c.name === '连射弩箭'));
    assert('steal: 新装备生效', p1().weapon?.name === '奇盾');
  }

  resetScenario();
  {
    const steal = card('steal-t4', 'steal', '妙手偶得');
    set(`p1.hand.push(${JSON.stringify(steal)}); p2.hand = []; p2.weapon = null; selectedCardUid = 'steal-t4'; selectedTargetId = p2.id;`);
    set('useStealCard()');
    const s = gs();
    assert('steal: 落空后仍正常结算', s.phase === 'PLAY' && s.pendingSpell === null);
  }

  resetScenario();
  {
    const steal = card('steal-t5', 'steal', '妙手偶得');
    set(`p1.hand.push(${JSON.stringify(steal)}); p2.hand = [${JSON.stringify(card('k5','kill','杀'))}]; p2.weapon = ${JSON.stringify({ weaponId: 'tian-she-order', name: '天赦令', effect: 'x' })}; selectedCardUid = 'steal-t5'; selectedTargetId = p2.id;`);
    set('useStealCard()');
    const s = gs();
    assert('steal: 天赦令免疫', p2().hand.length === 1 && p1().hand.length === 0 && p2().weapon?.name === '天赦令' && s.phase === 'PLAY');
  }

  // 响应流程：目标真实玩家持有无法选中 → RESPONSE；承受/打出无法选中
  resetScenario();
  {
    const steal = card('steal-t6', 'steal', '妙手偶得');
    set(`p1.hand.push(${JSON.stringify(steal)}); p2.hand = [${JSON.stringify(card('u6','untargetable','无法选中'))}, ${JSON.stringify(card('k6','kill','杀'))}]; selectedCardUid = 'steal-t6'; selectedTargetId = p2.id;`);
    set('useStealCard()');
    assert('steal响应: 进入RESPONSE并指向目标', gs().phase === 'RESPONSE' && gs().pendingSpell?.currentTargetId === p2().id);
    set('currentPlayer = gameState.players[1]; acceptSpellEffect()');
    const s = gs();
    assert('steal响应-承受: 正常结算回PLAY', s.phase === 'PLAY' && s.pendingSpell === null);
    assert('steal响应-承受: 目标失去1张', p2().hand.length === 1);
    assert('steal响应-承受: 使用者获得1张', p1().hand.length === 1);
  }

  resetScenario();
  {
    const steal = card('steal-t7', 'steal', '妙手偶得');
    set(`p1.hand.push(${JSON.stringify(steal)}); p2.hand = [${JSON.stringify(card('u7','untargetable','无法选中'))}, ${JSON.stringify(card('k7','kill','杀'))}]; selectedCardUid = 'steal-t7'; selectedTargetId = p2.id;`);
    set('useStealCard()');
    set('currentPlayer = gameState.players[1]; selectedCardUid = "u7"; useUntargetableForSpell()');
    const s = gs();
    assert('steal响应-无法选中: 取消成功', s.phase === 'PLAY' && s.pendingSpell === null);
    assert('steal响应-无法选中: 未发生偷取', p2().hand.length === 1 && p1().hand.length === 0);
    assert('steal响应-无法选中: 无法选中已弃置', s.discardPile.some((c) => c.uid === 'u7'));
  }

  // ---- 禁令 ----
  resetScenario();
  {
    const ban = card('ban-t1', 'ban', '禁令', { point: 1 });
    set(`p1.hand.push(${JSON.stringify(ban)}); p2.hand = [${JSON.stringify(card('k1','kill','杀',{point:1}))}]; p2.weapon = ${JSON.stringify({ weaponId: 'qi-shield', name: '奇盾', effect: 'x' })}; selectedCardUid = 'ban-t1'; selectedTargetId = p2.id;`);
    set('useBanCard()');
    assert('ban: 奇数点弃装备', p2().weapon === null && gs().discardPile.some((c) => c.name === '奇盾') && gs().phase === 'PLAY');
  }
  resetScenario();
  {
    const ban = card('ban-t2', 'ban', '禁令', { point: 2 });
    set(`p1.hand.push(${JSON.stringify(ban)}); p2.hand = [${JSON.stringify(card('k2','kill','杀',{point:2}))}]; selectedCardUid = 'ban-t2'; selectedTargetId = p2.id;`);
    set('useBanCard()');
    assert('ban: 偶数点沉默', p2().statusEffects.silencePendingTurns === 1 && gs().phase === 'PLAY');
  }
  resetScenario();
  {
    const ban = card('ban-t3', 'ban', '禁令', { point: 1 });
    set(`p1.hand.push(${JSON.stringify(ban)}); p2.hand = []; selectedCardUid = 'ban-t3'; selectedTargetId = p2.id;`);
    set('useBanCard()');
    assert('ban: 无手牌直接沉默', p2().statusEffects.silencePendingTurns === 1 && gs().phase === 'PLAY');
  }

  // ---- 死神 ----
  resetScenario();
  {
    const dg = card('dg-t1', 'death-god', '死神');
    set(`p1.hand.push(${JSON.stringify(dg)}); p2.hand = [${JSON.stringify(card('k1','kill','杀'))}]; selectedCardUid = 'dg-t1'; selectedTargetId = p2.id;`);
    set('useDeathGodCard()');
    assert('死神: 有杀不索命', p2().hp === p2().maxHp && gs().phase === 'PLAY');
  }
  resetScenario();
  {
    const dg = card('dg-t2', 'death-god', '死神');
    set(`p1.hand.push(${JSON.stringify(dg)}); p2.hand = [${JSON.stringify(card('h2','heal','奶'))}]; selectedCardUid = 'dg-t2'; selectedTargetId = p2.id;`);
    set('useDeathGodCard()');
    assert('死神: 无杀进入濒死', gs().phase === 'DYING' && gs().pendingRescue?.targetId === p2().id && p2().hp === 0);
  }
  resetScenario();
  {
    const dg = card('dg-t3', 'death-god', '死神');
    set(`p1.hand.push(${JSON.stringify(dg)}); p2.hand = [${JSON.stringify(card('d3','dodge','闪'))}]; selectedCardUid = 'dg-t3'; selectedTargetId = p2.id;`);
    set('useDeathGodCard()');
    assert('死神: 无奶直接阵亡', gs().players[1].alive === false && gs().status === 'ENDED');
  }

  // ---- 爱神 ----
  resetScenario();
  {
    const lg = card('lg-t1', 'love-god', '爱神');
    set(`p1.hand.push(${JSON.stringify(lg)}); p1.hp = 2; p2.hp = 0; p2.hand = [${JSON.stringify(card('h1','heal','奶'))}]; selectedCardUid = 'lg-t1'; selectedTargetId = p1.id; selectedSecondaryTargetId = p2.id;`);
    set('useLoveGodCard()');
    assert('爱神: 平均分配', gs().players[0].hp === 1 && gs().players[1].hp === 1 && gs().phase === 'PLAY');
  }

  // ---- 茂生 ----
  resetScenario();
  {
    const ms = card('ms-t1', 'maosheng', '茂生');
    set(`p1.hand.push(${JSON.stringify(ms)}); gameState.deck = [${JSON.stringify(card('x1','kill','杀'))}, ${JSON.stringify(card('x2','dodge','闪'))}]; selectedCardUid = 'ms-t1';`);
    set('useMaoshengCard()');
    assert('茂生: 摸2张', p1().hand.length === 2 && gs().phase === 'PLAY');
  }

  // ---- 天罚 ----
  resetScenario();
  {
    const dp = card('dp-t1', 'divine-punish', '天罚');
    set(`p1.hand.push(${JSON.stringify(dp)}); p1.hand.push(${JSON.stringify(card('k1','kill','杀'))}); p2.hand = []; selectedCardUid = 'dp-t1';`);
    set('useDivinePunishCard()');
    assert('天罚: 手牌最多者失去1血', gs().players[0].hp === gs().players[0].maxHp - 1 && gs().players[1].hp === gs().players[1].maxHp && gs().phase === 'PLAY');
  }

  // 天罚同时命中两个濒死玩家：后救活的不应直接杀死先濒死的，先濒死者应轮到自救
  resetScenario();
  {
    const dp = card('dp-t2', 'divine-punish', '天罚');
    set(`p1.hand = [${JSON.stringify(dp)}, ${JSON.stringify(card('h1','heal','奶'))}]; p2.hand = [${JSON.stringify(card('h2','heal','奶'))}, ${JSON.stringify(card('k2','kill','杀'))}]; p1.hp = 1; p2.hp = 1; selectedCardUid = 'dp-t2';`);
    set('useDivinePunishCard()');
    const s1 = gs();
    assert('天罚双濒死: 第二目标正在濒死', s1.phase === 'DYING' && s1.pendingRescue?.targetId === p2().id, `phase=${s1.phase} rescue=${s1.pendingRescue?.targetId} prev=${s1.pendingRescue?.previousRescue?.targetId}`);
    set(`currentPlayer = gameState.players[1]; selectedCardUid = 'h2'; useRescueHeal()`);
    const s2 = gs();
    assert('天罚双濒死: 第二目标救活后第一目标仍可自救', s2.phase === 'DYING' && s2.pendingRescue?.targetId === p1().id, `phase=${s2.phase} rescue=${s2.pendingRescue?.targetId} status=${s2.status} p1alive=${s2.players[0].alive} p2alive=${s2.players[1].alive}`);
  }

  // ---- 判定牌 ----
  resetScenario();
  {
    const jd = card('jd-t1', 'judgment', '天雷', { judgmentId: 'heaven-thunder', condition: 'odd-hand', turnsLeft: 4 });
    set(`p1.hand.push(${JSON.stringify(jd)}); p1.hand.push(${JSON.stringify(card('k1','kill','杀'))}); selectedCardUid = 'jd-t1';`);
    set('useJudgmentCard()');
    assert('判定: 进入轮转', gs().activeJudgments.length === 1 && gs().phase === 'PLAY');
    set('rotateActiveJudgments(gameState.players[0])');
    const j = gs();
    assert('判定: 奇数手牌触发天雷', j.players[0].hp === j.players[0].maxHp - 2 && j.activeJudgments.length === 0);
  }

  // ---- 杀 ----
  resetScenario();
  {
    const kill = card('kill-t1', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p2.hand = [${JSON.stringify(card('d1','dodge','闪'))}]; selectedCardUid = 'kill-t1'; selectedTargetId = p2.id;`);
    set('playKill()');
    assert('杀: 进入响应阶段', gs().phase === 'RESPONSE' && gs().pendingAttack?.targetId === p2().id);
    set('currentPlayer = gameState.players[1]; selectedCardUid = "d1"; respondDodge()');
    assert('杀: 打出闪抵消', p2().hp === p2().maxHp && gs().phase === 'PLAY');
  }
  resetScenario();
  {
    const kill = card('kill-t2', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p2.hand = []; selectedCardUid = 'kill-t2'; selectedTargetId = p2.id;`);
    set('playKill()');
    const s = gs();
    assert('杀: 无闪直接受伤', p2().hp === p2().maxHp - 1 && s.phase === 'PLAY');
  }

  // 妙手装备触发
  resetScenario();
  {
    const kill = card('kill-t3', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p1.weapon = ${JSON.stringify({ weaponId: 'miao-shou', name: '妙手', effect: 'x' })}; p2.hand = [${JSON.stringify(card('d1','dodge','闪'))}, ${JSON.stringify(card('k1','kill','杀'))}]; selectedCardUid = 'kill-t3'; selectedTargetId = p2.id;`);
    set('playKill()');
    set('currentPlayer = gameState.players[1]; takeDamage()');
    assert('妙手: 伤害后偷牌', p1().hand.length === 1 && p2().hand.length === 1);
  }

  // 吸血刀
  resetScenario();
  {
    const kill = card('kill-t4', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p1.weapon = ${JSON.stringify({ weaponId: 'vampire-blade', name: '吸血刀', effect: 'x' })}; p1.hp = 1; p2.hand = []; selectedCardUid = 'kill-t4'; selectedTargetId = p2.id;`);
    set('playKill()');
    assert('吸血刀: 造成伤害回血', p1().hp === 2 && gs().phase === 'PLAY');
  }

  // 奇盾
  resetScenario();
  {
    const kill = card('kill-t5', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p2.hand = []; p2.weapon = ${JSON.stringify({ weaponId: 'qi-shield', name: '奇盾', effect: 'x' })}; selectedCardUid = 'kill-t5'; selectedTargetId = p2.id;`);
    set('playKill()');
    assert('奇盾: 首次杀伤害-1', p2().hp === p2().maxHp && gs().phase === 'PLAY');
  }

  // 轩辕剑无视奇盾
  resetScenario();
  {
    const kill = card('kill-t6', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p1.weapon = ${JSON.stringify({ weaponId: 'xuanyuan-sword', name: '轩辕剑', effect: 'x' })}; p2.hand = []; p2.weapon = ${JSON.stringify({ weaponId: 'qi-shield', name: '奇盾', effect: 'x' })}; selectedCardUid = 'kill-t6'; selectedTargetId = p2.id;`);
    set('playKill()');
    assert('轩辕剑: 无视奇盾', p2().hp === p2().maxHp - 1);
  }

  // 硬弓
  resetScenario();
  {
    const kill = card('kill-t7', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p1.weapon = ${JSON.stringify({ weaponId: 'hard-bow', name: '硬弓', effect: 'x' })}; p2.hand = []; selectedCardUid = 'kill-t7'; selectedTargetId = p2.id;`);
    set('playKill()');
    assert('硬弓: 任意目标', p2().hp === p2().maxHp - 1 && gs().phase === 'PLAY');
  }

  // 奇门遁甲：转移伤害给相邻玩家
  resetScenario();
  {
    const p3 = { id: 'p3', nickname: '玩家三', role: 'player' };
    set(`gameState.players.push(${JSON.stringify({ ...p3, maxHp: 4, hp: 4, hand: [], alive: true, statusEffects: {}, weapon: null, weaponUsage: {}, skillUsage: {} })}); gameState.players = [gameState.players[0], gameState.players[2], gameState.players[1]];`);
    const kill = card('kill-q1', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); gameState.players[2].weapon = ${JSON.stringify({ weaponId: 'qimen-dunjia', name: '奇门遁甲', effect: 'x' })}; gameState.players[2].hand = []; selectedCardUid = 'kill-q1'; selectedTargetId = 'p2';`);
    set('playKill()');
    const s = gs();
    assert('奇门遁甲: 伤害转移给相邻玩家', s.players[2].hp === s.players[2].maxHp && s.players[1].hp === 3, `p2hp=${s.players[2].hp} p3hp=${s.players[1].hp}`);
  }

  // 奇门遁甲：每回合仅一次
  resetScenario();
  {
    const p3 = { id: 'p3', nickname: '玩家三', role: 'player' };
    set(`gameState.players.push(${JSON.stringify({ ...p3, maxHp: 4, hp: 4, hand: [], alive: true, statusEffects: {}, weapon: null, weaponUsage: {}, skillUsage: {} })}); gameState.players = [gameState.players[0], gameState.players[2], gameState.players[1]];`);
    const kill1 = card('kill-q2a', 'kill', '杀');
    const kill2 = card('kill-q2b', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill1)}); p1.hand.push(${JSON.stringify(kill2)}); gameState.players[2].weapon = ${JSON.stringify({ weaponId: 'qimen-dunjia', name: '奇门遁甲', effect: 'x' })}; gameState.players[2].hand = []; selectedCardUid = 'kill-q2a'; selectedTargetId = 'p2';`);
    set('playKill()');
    const s1 = gs();
    set(`selectedCardUid = 'kill-q2b'; selectedTargetId = 'p2'; gameState.players[1].hp = 4; gameState.killUsed = false; playKill()`);
    const s2 = gs();
    assert('奇门遁甲: 第二刀不再转移', s2.players[2].hp === s2.players[2].maxHp - 1 && s2.players[1].hp === 4, `p2hp=${s2.players[2].hp} p3hp=${s2.players[1].hp}`);
  }

  // 奇门遁甲转移给有奇盾的玩家：新承受者奇盾生效
  resetScenario();
  {
    const p3 = { id: 'p3', nickname: '玩家三', role: 'player' };
    set(`gameState.players.push(${JSON.stringify({ ...p3, maxHp: 4, hp: 4, hand: [], alive: true, statusEffects: {}, weapon: { weaponId: 'qi-shield', name: '奇盾', effect: 'x' }, weaponUsage: {}, skillUsage: {} })}); gameState.players = [gameState.players[0], gameState.players[2], gameState.players[1]];`);
    const kill = card('kill-q3', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); gameState.players[2].weapon = ${JSON.stringify({ weaponId: 'qimen-dunjia', name: '奇门遁甲', effect: 'x' })}; gameState.players[2].hand = []; selectedCardUid = 'kill-q3'; selectedTargetId = 'p2';`);
    set('playKill()');
    const s = gs();
    assert('奇门遁甲: 新承受者奇盾-1', s.players[2].hp === s.players[2].maxHp && s.players[1].hp === 4, `p2hp=${s.players[2].hp} p3hp=${s.players[1].hp}`);
  }

  // 爆炸弩副目标有无法选中：取消只针对自己，主目标伤害正常
  resetScenario();
  {
    const p3 = { id: 'p3', nickname: '玩家三', role: 'player' };
    set(`gameState.players.push(${JSON.stringify({ ...p3, maxHp: 4, hp: 4, hand: [], alive: true, statusEffects: {}, weapon: null, weaponUsage: {}, skillUsage: {} })});`);
    const kill = card('kill-q4', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p1.weapon = ${JSON.stringify({ weaponId: 'explosive-crossbow', name: '爆炸弩', effect: 'x' })}; p2.hand = []; gameState.players[2].hand = [${JSON.stringify(card('u-q4','untargetable','无法选中'))}]; selectedCardUid = 'kill-q4'; selectedTargetId = p2.id; selectedSecondaryTargetId = 'p3';`);
    set('playKill()');
    const s1 = gs();
    assert('爆炸弩无法选中: 主目标先结算', s1.phase === 'RESPONSE' && s1.pendingAttack?.targetId === 'p3' && s1.players[1].hp === s1.players[1].maxHp - 1, `phase=${s1.phase} target=${s1.pendingAttack?.targetId} p2hp=${s1.players[1].hp}`);
    set(`currentPlayer = gameState.players[2]; selectedCardUid = 'u-q4'; useUntargetableCard()`);
    const s2 = gs();
    assert('爆炸弩无法选中: 副目标取消后结算完成', s2.phase === 'PLAY' && s2.pendingAttack === null && s2.players[2].hp === 4, `phase=${s2.phase} p3hp=${s2.players[2].hp}`);
  }

  // 死神目标持有无法选中：可取消
  resetScenario();
  {
    const dg = card('dg-q5', 'death-god', '死神');
    set(`p1.hand.push(${JSON.stringify(dg)}); p2.hand = [${JSON.stringify(card('u-q5','untargetable','无法选中'))}]; selectedCardUid = 'dg-q5'; selectedTargetId = p2.id;`);
    set('useDeathGodCard()');
    assert('死神无法选中: 进入响应', gs().phase === 'RESPONSE' && gs().pendingSpell?.currentTargetId === p2().id);
    set(`currentPlayer = gameState.players[1]; selectedCardUid = 'u-q5'; useUntargetableForSpell()`);
    assert('死神无法选中: 取消成功', gs().phase === 'PLAY' && gs().pendingSpell === null && p2().hp === p2().maxHp);
  }

  // 爱神目标含天赦令持有者：仅免役者被跳过，另一目标无分配对象则不变
  resetScenario();
  {
    const p3 = { id: 'p3', nickname: '玩家三', role: 'player' };
    set(`gameState.players.push(${JSON.stringify({ ...p3, maxHp: 4, hp: 4, hand: [], alive: true, statusEffects: {}, weapon: null, weaponUsage: {}, skillUsage: {} })});`);
    const lg = card('lg-q6', 'love-god', '爱神');
    set(`p1.hand.push(${JSON.stringify(lg)}); p2.weapon = ${JSON.stringify({ weaponId: 'tian-she-order', name: '天赦令', effect: 'x' })}; p1.hp = 2; p2.hp = 4; gameState.players[2].hp = 3; selectedCardUid = 'lg-q6'; selectedTargetId = p2.id; selectedSecondaryTargetId = 'p3';`);
    set('useLoveGodCard()');
    const s = gs();
    assert('爱神天赦令: 免疫者被跳过且不卡死', s.phase === 'PLAY' && s.pendingSpell === null && s.players[1].hp === 4 && s.players[2].hp === 3, `phase=${s.phase} p2hp=${s.players[1].hp} p3hp=${s.players[2].hp}`);
  }

  // ---- 特技牌 ----
  resetScenario();
  {
    const sp = card('sp-t1', 'special', '英雄-特技', { specialSkill: { templateId: 'SPECIAL_DAMAGE_2', name: '天降神威', value: 1, description: '对一名其他玩家造成 2 点伤害' } });
    set(`p2.maxHp = 4; p2.hp = 4; p1.hand.push(${JSON.stringify(sp)}); p2.hand = []; selectedCardUid = 'sp-t1'; selectedTargetId = p2.id;`);
    set('useSpecialCard()');
    const s = gs();
    assert('特技牌: 对目标造成2点伤害', s.players[1].hp === s.players[1].maxHp - 2 && s.phase === 'PLAY', `p2hp=${s.players[1].hp} phase=${s.phase}`);
  }

  resetScenario();
  {
    const sp = card('sp-t2', 'special', '英雄-特技', { specialSkill: { templateId: 'SPECIAL_DAMAGE_2', name: '天降神威', value: 1, description: '对一名其他玩家造成 2 点伤害' } });
    set(`p1.hand.push(${JSON.stringify(sp)}); p2.hand = [${JSON.stringify(card('u-sp2','untargetable','无法选中'))}]; selectedCardUid = 'sp-t2'; selectedTargetId = p2.id;`);
    set('useSpecialCard()');
    assert('特技牌响应: 进入RESPONSE', gs().phase === 'RESPONSE' && gs().pendingSpell?.currentTargetId === p2().id);
    set(`currentPlayer = gameState.players[1]; selectedCardUid = 'u-sp2'; useUntargetableForSpell()`);
    const s = gs();
    assert('特技牌响应: 无法选中取消', s.phase === 'PLAY' && s.pendingSpell === null && s.players[1].hp === s.players[1].maxHp);
  }

  resetScenario();
  {
    const sp = card('sp-t3', 'special', '英雄-特技', { specialSkill: { templateId: 'SPECIAL_DAMAGE_2', name: '天降神威', value: 1, description: '对一名其他玩家造成 2 点伤害' } });
    set(`p1.hand.push(${JSON.stringify(sp)}); p2.weapon = ${JSON.stringify({ weaponId: 'tian-she-order', name: '天赦令', effect: 'x' })}; p2.hand = []; selectedCardUid = 'sp-t3'; selectedTargetId = p2.id;`);
    set('useSpecialCard()');
    const s = gs();
    assert('特技牌: 天赦令免疫', s.players[1].hp === s.players[1].maxHp && s.phase === 'PLAY', `p2hp=${s.players[1].hp}`);
  }

  resetScenario();
  {
    const sp = card('sp-t4', 'special', '英雄-特技', { specialSkill: { templateId: 'SPECIAL_DRAW_3', name: '乾坤一掷', value: 1, description: '立即摸 3 张牌' } });
    set(`p1.hand.push(${JSON.stringify(sp)}); gameState.deck = [${JSON.stringify(card('x1','kill','杀'))}, ${JSON.stringify(card('x2','dodge','闪'))}, ${JSON.stringify(card('x3','heal','奶'))}]; selectedCardUid = 'sp-t4';`);
    set('useSpecialCard()');
    const s = gs();
    assert('特技牌: 摸3张', s.players[0].hand.length === 3 && s.phase === 'PLAY', `hand=${s.players[0].hand.length}`);
  }

  resetScenario();
  {
    const sp = card('sp-t5', 'special', '英雄-特技', { specialSkill: { templateId: 'SPECIAL_SHIELD_2', name: '金钟罩', value: 1, description: '本回合内受到的第一次伤害减少 2 点' } });
    set(`p1.hand.push(${JSON.stringify(sp)}); p2.hand = []; selectedCardUid = 'sp-t5';`);
    set('useSpecialCard()');
    const kill = card('kill-sp5', 'kill', '杀');
    set(`currentPlayer = gameState.players[1]; p2.hand.push(${JSON.stringify(kill)}); selectedCardUid = 'kill-sp5'; selectedTargetId = p1.id;`);
    set('playKill()');
    const s = gs();
    assert('特技牌: 护盾减伤2', s.players[0].hp === s.players[0].maxHp && s.phase === 'PLAY', `p1hp=${s.players[0].hp}`);
  }

  resetScenario();
  {
    const sp = card('sp-t6', 'special', '英雄-特技', { specialSkill: { templateId: 'SPECIAL_AOE_1', name: '横扫千军', value: 1, description: '对所有其他玩家各造成 1 点伤害' } });
    set(`gameState.players.push(${JSON.stringify({ id: 'p3', nickname: '玩家三', role: 'player', maxHp: 4, hp: 4, hand: [], alive: true, statusEffects: {}, weapon: null, weaponUsage: {}, skillUsage: {} })});`);
    set(`p1.hand.push(${JSON.stringify(sp)}); p2.hand = []; gameState.players[2].hand = []; selectedCardUid = 'sp-t6';`);
    set('useSpecialCard()');
    const s = gs();
    assert('特技牌AOE: 所有其他玩家各受1点伤害', s.players[1].hp === s.players[1].maxHp - 1 && s.players[2].hp === 3 && s.phase === 'PLAY', `p2hp=${s.players[1].hp} p3hp=${s.players[2].hp}`);
  }

  // 沉默
  resetScenario();
  {
    const si = card('si-t1', 'silence', '沉默');
    set(`p1.hand.push(${JSON.stringify(si)}); selectedCardUid = 'si-t1'; selectedTargetId = p2.id;`);
    set('useSilenceCard()');
    assert('沉默: 目标下回合沉默', p2().statusEffects.silencePendingTurns === 1);
    set('gameState.currentPlayerId = p2.id; activateSilenceIfNeeded(p2)');
    assert('沉默: 出牌阶段生效', p2().statusEffects.silenceActive === true);
  }

  // 玉石俱焚
  resetScenario();
  {
    const doom = card('doom-t1', 'mutual-doom', '玉石俱焚');
    set(`p1.hand.push(${JSON.stringify(doom)}); gameState.players.push(${JSON.stringify({ id: 'p3', nickname: '玩家三', role: 'player', hp: 2, maxHp: 2, hand: [], weapon: null, weaponUsage: {}, statusEffects: {}, skillUsage: {}, alive: true, isDemo: true })}); gameState.pendingRescue = { attackerId: null, targetId: p1.id, reason: 'damage', returnPhase: 'PLAY', returnPlayerId: null, previousRescue: null }; gameState.phase = 'DYING'; gameState.currentPlayerId = p1.id; currentPlayer = p1;`);
    set('selectedCardUid = "doom-t1"; useDoomCard(p1, gameState.players[2])');
    assert('玉石俱焚: 目标进入濒死', gs().phase === 'DYING' && gs().pendingRescue?.targetId === 'p3' && p2().alive);
  }

  // ---- 摸牌与回合 ----
  resetScenario();
  {
    set(`gameState.deck = [${JSON.stringify(card('z1','kill','杀'))}, ${JSON.stringify(card('z2','dodge','闪'))}, ${JSON.stringify(card('z3','heal','奶'))}, ${JSON.stringify(card('z4','kill','杀'))}];`);
    set('nextTurn()');
    assert('回合: 进入摸牌阶段', gs().phase === 'DRAWING' && gs().drawPlayerId === p2().id);
    assert('回合: 摸牌数量正确', p2().hand.length === 2, `hand=${p2().hand.length}`);
    set(`gameState.drawDeadline = Date.now() - 1; gameState.phase = 'PLAY';`);
  }

  // 回合结束弃牌
  resetScenario();
  {
    set(`p2.hand = [${JSON.stringify(card('a1','kill','杀'))}, ${JSON.stringify(card('a2','dodge','闪'))}, ${JSON.stringify(card('a3','heal','奶'))}, ${JSON.stringify(card('a4','kill','杀'))}, ${JSON.stringify(card('a5','dodge','闪'))}, ${JSON.stringify(card('a6','heal','奶'))}]; gameState.currentPlayerId = p2.id; currentPlayer = p2; gameState.phase = 'PLAY';`);
    set('directPass(p2)');
    assert('弃牌: 超额手牌被弃置', p2().hand.length === 5);
  }

  // 装备牌：新装备替换旧装备回到手牌
  resetScenario();
  {
    const w1 = card('w1', 'weapon', '硬弓', { weaponId: 'hard-bow', effect: 'x' });
    const w2 = card('w2', 'weapon', '奇盾', { weaponId: 'qi-shield', effect: 'x' });
    set(`p1.hand.push(${JSON.stringify(w1)}); p1.hand.push(${JSON.stringify(w2)}); selectedCardUid = 'w1';`);
    set('equipCard()');
    set('selectedCardUid = "w2"; equipCard()');
    assert('装备替换: 旧装备回手牌', p1().weapon?.name === '奇盾' && p1().hand.some((c) => c.uid === 'w1'));
  }

  // 沉默状态不能使用牌
  resetScenario();
  {
    const kill = card('kill-t8', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p1.statusEffects.silenceActive = true; selectedCardUid = 'kill-t8'; selectedTargetId = p2.id;`);
    set('playKill()');
    assert('沉默: 无法出杀', gs().phase === 'PLAY' && p1().hand.length === 1);
  }

  // 连射弩箭：本回合杀不限次数
  resetScenario();
  {
    const kill = card('kill-t9', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p1.weapon = ${JSON.stringify({ weaponId: 'rapid-crossbow', name: '连射弩箭', effect: 'x' })}; gameState.killUsed = true; p2.hand = []; selectedCardUid = 'kill-t9'; selectedTargetId = p2.id;`);
    set('playKill()');
    assert('连射弩箭: 本回合仍可出杀', p2().hp === p2().maxHp - 1 && gs().phase === 'PLAY');
  }

  // 无法选中抵消杀
  resetScenario();
  {
    const kill = card('kill-t10', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p2.hand = [${JSON.stringify(card('u10','untargetable','无法选中'))}]; selectedCardUid = 'kill-t10'; selectedTargetId = p2.id;`);
    set('playKill()');
    set('currentPlayer = gameState.players[1]; selectedCardUid = "u10"; useUntargetableCard()');
    assert('无法选中: 抵消杀', p2().hp === p2().maxHp && gs().phase === 'PLAY' && gs().pendingAttack === null);
  }

  // 爆炸弩：主目标濒死后救援，继续第二目标
  resetScenario();
  {
    const kill = card('kill-t11', 'kill', '杀');
    const p3 = { id: 'p3', nickname: '玩家三', role: 'player', hp: 2, maxHp: 2, hand: [card('d3', 'dodge', '闪')], weapon: null, weaponUsage: {}, statusEffects: {}, skillUsage: {}, alive: true, isDemo: false };
    set(`p1.hand.push(${JSON.stringify(kill)}); p1.weapon = ${JSON.stringify({ weaponId: 'explosive-crossbow', name: '爆炸弩', effect: 'x' })}; gameState.players.push(${JSON.stringify(p3)}); p2.hp = 1; p2.hand = [${JSON.stringify(card('h2', 'heal', '奶'))}]; selectedCardUid = 'kill-t11'; selectedTargetId = p2.id; selectedSecondaryTargetId = 'p3';`);
    set('playKill()');
    const s1 = gs();
    assert('爆炸弩: 主目标进入濒死', s1.phase === 'DYING' && s1.pendingRescue?.targetId === p2().id, `phase=${s1.phase}`);
    set('currentPlayer = gameState.players[1]; useRescueHeal()');
    const s2 = gs();
    assert('爆炸弩: 救援后继续第二目标', s2.phase === 'RESPONSE' && s2.pendingAttack?.targetId === 'p3', `phase=${s2.phase}`);
    set('currentPlayer = gameState.players[2]; respondDodge()');
    assert('爆炸弩: 第二目标闪避后结算', gs().phase === 'PLAY' && gs().pendingAttack === null);
  }

  // 玉石俱焚：双方阵亡
  resetScenario();
  {
    const doom = card('doom-t2', 'mutual-doom', '玉石俱焚');
    const p3 = { id: 'p3', nickname: '玩家三', role: 'player', hp: 2, maxHp: 2, hand: [], weapon: null, weaponUsage: {}, statusEffects: {}, skillUsage: {}, alive: true, isDemo: true };
    set(`p1.hand.push(${JSON.stringify(doom)}); gameState.players.push(${JSON.stringify(p3)}); p1.hp = 0; gameState.pendingRescue = { attackerId: null, targetId: p1.id, reason: 'damage', returnPhase: 'PLAY', returnPlayerId: null, previousRescue: null }; gameState.phase = 'DYING'; gameState.currentPlayerId = p1.id; currentPlayer = p1; selectedCardUid = 'doom-t2'; useDoomCard(p1, p2)`);
    set('resolveDying(false)');
    assert('玉石俱焚: 目标无奶阵亡', gs().players[1].alive === false);
    assert('玉石俱焚: 使用者同归于尽', gs().players[0].alive === false);
    assert('玉石俱焚: 对局结束', gs().status === 'ENDED');
  }

  // 迷局判定：跳过出牌阶段
  resetScenario();
  {
    set(`gameState.activeJudgments = [{ uid: 'pz1', judgmentId: 'puzzle', name: '迷局', effect: 'x', condition: 'not-full-hp', turnsLeft: 3 }]; p2.hp = 1;`);
    set('rotateActiveJudgments(p2)');
    assert('迷局: 触发跳过出牌', gs().skipPlayRound === gs().round && gs().activeJudgments.length === 0);
  }

  // 断粮判定：少摸2张
  resetScenario();
  {
    set(`gameState.activeJudgments = [{ uid: 'dl1', judgmentId: 'cut-supply', name: '断粮', effect: 'x', condition: 'even-hand', turnsLeft: 4 }]; p2.hand = [${JSON.stringify(card('a1','kill','杀'))}, ${JSON.stringify(card('a2','dodge','闪'))}]; gameState.drawCount = 2;`);
    set('rotateActiveJudgments(p2)');
    assert('断粮: 摸牌数减少2', gs().drawCount === 0);
  }

  // 锦囊：摸牌阶段多摸2张
  resetScenario();
  {
    set(`gameState.deck = [${JSON.stringify(card('q1','kill','杀'))}, ${JSON.stringify(card('q2','dodge','闪'))}, ${JSON.stringify(card('q3','heal','奶'))}, ${JSON.stringify(card('q4','kill','杀'))}, ${JSON.stringify(card('q5','dodge','闪'))}]; p2.weapon = ${JSON.stringify({ weaponId: 'jin-nang', name: '锦囊', effect: 'x' })};`);
    set('nextTurn()');
    assert('锦囊: 摸4张', p2().hand.length === 4, `hand=${p2().hand.length}`);
  }

  // 房主超时代为推进（真实玩家掉线兜底）
  resetScenario();
  {
    const kill = card('kill-t12', 'kill', '杀');
    set(`p1.hand.push(${JSON.stringify(kill)}); p2.hand = [${JSON.stringify(card('d12','dodge','闪'))}]; selectedCardUid = 'kill-t12'; selectedTargetId = p2.id;`);
    set('playKill()');
    set('gameState.responseDeadline = Date.now() - 1; tick()');
    assert('超时代为: 杀响应超时由房主结算', gs().phase === 'PLAY' && p2().hp === p2().maxHp - 1, `phase=${gs().phase} hp=${p2().hp}`);
  }
  resetScenario();
  {
    const steal = card('steal-t8', 'steal', '妙手偶得');
    set(`p1.hand.push(${JSON.stringify(steal)}); p2.hand = [${JSON.stringify(card('u8','untargetable','无法选中'))}]; selectedCardUid = 'steal-t8'; selectedTargetId = p2.id;`);
    set('useStealCard()');
    set('gameState.responseDeadline = Date.now() - 1; tick()');
    assert('超时代为: 术卡响应超时由房主结算', gs().phase === 'PLAY' && p1().hand.length === 1 && p2().hand.length === 0, `phase=${gs().phase}`);
  }
  resetScenario();
  {
    set(`p2.hand = [${JSON.stringify(card('a1','kill','杀'))}]; gameState.currentPlayerId = p2.id; gameState.phase = 'PLAY'; gameState.turnDeadline = Date.now() - 1;`);
    set('tick()');
    assert('超时代为: 回合超时由房主结束', gs().phase === 'DRAWING' && gs().currentPlayerId === p1().id, `phase=${gs().phase}`);
  }
  resetScenario();
  {
    set(`p2.hp = 0; p2.hand = [${JSON.stringify(card('h13','heal','奶'))}]; gameState.pendingRescue = { attackerId: p1.id, targetId: p2.id, reason: 'damage' }; gameState.phase = 'DYING'; gameState.responseDeadline = Date.now() - 1;`);
    set('tick()');
    assert('超时代为: 濒死超时由房主结算', gs().players[1].alive === false && gs().status === 'ENDED', `alive=${gs().players[1].alive}`);
  }

  console.log(`Section 1 single-context tests done (${results.length} records so far)`);
}

// ---------------------------------------------------------------------------
// Section 2: server authorization logic tests
// ---------------------------------------------------------------------------
{
  const players = [
    { id: 'p1', nickname: '玩家一', role: 'host' },
    { id: 'p2', nickname: '玩家二', role: 'player' }
  ];
  const room = makeRoom(players);
  const mkGame = (over) => ({
    version: 10, status: 'PLAYING', phase: 'PLAY', round: 1, currentPlayerId: 'p1',
    pendingAttack: null, pendingSpell: null, pendingRescue: null, drawPlayerId: null,
    players: [], deck: [], discardPile: [], actionLog: [], ...over
  });

  // PLAY: current player authorized
  {
    const prev = mkGame({});
    const next = mkGame({ phase: 'RESPONSE', pendingAttack: { attackerId: 'p1', targetId: 'p2' } });
    assert('server: 出牌阶段由当前玩家操作', gameMutationAllowed({ ...room, game: prev }, { ...room, game: next }, 'p1') === true);
    assert('server: 出牌阶段其他玩家被拒绝', gameMutationAllowed({ ...room, game: prev }, { ...room, game: next }, 'p2') === false);
  }
  // attack RESPONSE: target authorized
  {
    const prev = mkGame({ phase: 'RESPONSE', pendingAttack: { attackerId: 'p1', targetId: 'p2' } });
    const next = mkGame({ phase: 'PLAY' });
    assert('server: 杀响应阶段由目标操作', gameMutationAllowed({ ...room, game: prev }, { ...room, game: next }, 'p2') === true);
  }
  // spell RESPONSE: target must be authorized (currently buggy)
  {
    const prev = mkGame({ phase: 'RESPONSE', pendingAttack: null, pendingSpell: { card: { name: '妙手偶得' }, casterId: 'p1', currentTargetId: 'p2', targetIds: ['p2'], targetIndex: 1, affectedIds: [] } });
    const next = mkGame({ phase: 'PLAY', pendingSpell: null });
    const allowed = gameMutationAllowed({ ...room, game: prev }, { ...room, game: next }, 'p2');
    record('server: 术卡响应阶段由目标操作', allowed === true, `实际=${allowed}`);
  }
  // DYING: target authorized
  {
    const prev = mkGame({ phase: 'DYING', pendingRescue: { targetId: 'p2' } });
    const next = mkGame({ phase: 'PLAY' });
    assert('server: 濒死阶段由濒死者操作', gameMutationAllowed({ ...room, game: prev }, { ...room, game: next }, 'p2') === true);
  }
  // DRAWING: drawing player authorized
  {
    const prev = mkGame({ phase: 'DRAWING', drawPlayerId: 'p2' });
    const next = mkGame({ phase: 'PLAY' });
    assert('server: 摸牌阶段由摸牌者操作', gameMutationAllowed({ ...room, game: prev }, { ...room, game: next }, 'p2') === true);
  }
  // Host timeout fallback: after the expected player's deadline, host may advance.
  {
    const expired = mkGame({ phase: 'RESPONSE', responseDeadline: Date.now() - 1000, pendingAttack: { attackerId: 'p1', targetId: 'p2' } });
    const next = mkGame({ phase: 'PLAY' });
    assert('server: 截止后房主可代为响应', gameMutationAllowed({ ...room, game: expired }, { ...room, game: next }, 'p1') === true);
    assert('server: 截止后无关玩家不可代为响应', gameMutationAllowed({ ...room, game: expired }, { ...room, game: next }, 'pX') === false);
  }
  {
    const notExpired = mkGame({ phase: 'RESPONSE', responseDeadline: Date.now() + 10000, pendingAttack: { attackerId: 'p1', targetId: 'p2' } });
    const next = mkGame({ phase: 'PLAY' });
    assert('server: 截止前房主不可代为响应', gameMutationAllowed({ ...room, game: notExpired }, { ...room, game: next }, 'p1') === false);
    assert('server: 截止前目标本人可响应', gameMutationAllowed({ ...room, game: notExpired }, { ...room, game: next }, 'p2') === true);
  }
  {
    const expiredSpell = mkGame({ phase: 'RESPONSE', responseDeadline: Date.now() - 1000, pendingSpell: { currentTargetId: 'p2', card: { name: '妙手偶得' } } });
    const next = mkGame({ phase: 'PLAY' });
    assert('server: 术卡截止后房主可代为结算', gameMutationAllowed({ ...room, game: expiredSpell }, { ...room, game: next }, 'p1') === true);
    const expiredTurn = mkGame({ phase: 'PLAY', turnDeadline: Date.now() - 1000, currentPlayerId: 'p2' });
    assert('server: 回合截止后房主可代为结束', gameMutationAllowed({ ...room, game: expiredTurn }, { ...room, game: next }, 'p1') === true);
    const expiredDraw = mkGame({ phase: 'DRAWING', drawDeadline: Date.now() - 1000, drawPlayerId: 'p2' });
    assert('server: 摸牌截止后房主可代为完成', gameMutationAllowed({ ...room, game: expiredDraw }, { ...room, game: next }, 'p1') === true);
    const expiredDying = mkGame({ phase: 'DYING', responseDeadline: Date.now() - 1000, pendingRescue: { targetId: 'p2' } });
    assert('server: 濒死截止后房主可代为结算', gameMutationAllowed({ ...room, game: expiredDying }, { ...room, game: next }, 'p1') === true);
  }
  console.log('Section 2 server auth tests done');
}

// ---------------------------------------------------------------------------
// Section 3: two-client multiplayer simulation of the steal freeze
// ---------------------------------------------------------------------------
{
  const players = [
    { id: 'p1', nickname: '玩家一', role: 'host' },
    { id: 'p2', nickname: '玩家二', role: 'player' }
  ];
  const room = makeRoom(players);
  const timers = { seq: 0, order: 0, now: 1750000000000, items: new Map() };
  let serverRooms = { '123456': JSON.parse(JSON.stringify(room)) };
  let ok = false;
  let lastReason = '';
  const authLog = [];

  function authorize(patchRoom, actorPlayerId) {
    const code = '123456';
    const currentRoom = serverRooms[code] || null;
    const currentRev = currentRoom?.revision ?? 0;
    const phase = currentRoom?.game?.phase || null;
    const pending = currentRoom?.game?.pendingSpell || null;
    if (currentRev !== (patchRoom.revision || 0)) { lastReason = `revision ${currentRev} != ${patchRoom.revision}`; authLog.push({ actor: actorPlayerId, revOk: false, phase, pending, serverRev: currentRev, patchRev: patchRoom.revision }); return false; }
    if (!gameMutationAllowed(currentRoom, patchRoom, actorPlayerId)) { lastReason = 'game-action-not-authorized'; authLog.push({ actor: actorPlayerId, revOk: true, allowed: false, phase, pending, actorId: actorPlayerId, prevCurrent: currentRoom?.game?.currentPlayerId, patchCurrent: patchRoom?.game?.currentPlayerId, patchPhase: patchRoom?.game?.phase }); return false; }
    patchRoom.revision = currentRev + 1;
    patchRoom.updatedAt = Date.now();
    serverRooms = { [code]: patchRoom };
    authLog.push({ actor: actorPlayerId, revOk: true, allowed: true, phase, pending, serverRev: currentRev });
    return true;
  }

  const clients = [];
  function broadcast() {
    clients.forEach((client) => {
      client.localStore.set(roomStorageKey, JSON.stringify(serverRooms));
      client.sb.dispatchStorage();
    });
  }

  players.forEach((p, index) => {
    const net = {
      saveRooms: async (rooms, meta) => {
        const patch = JSON.parse(JSON.stringify(rooms['123456']));
        if (authorize(patch, p.id)) {
          broadcast();
          return JSON.parse(JSON.stringify(serverRooms));
        }
        return JSON.parse(JSON.stringify(serverRooms));
      }
    };
    const client = bootClient(room, p.id, timers, net, false);
    clients.push(client);
  });

  // Host creates the game; broadcast to guest. Make first player deterministic.
  clients[0].eval('Math.random = () => 0');
  clients[0].eval('tryStartGame()');
  // Guest loads the now-created game.
  clients[1].eval('tryStartGame()');
  broadcast();

  const hostState = clients[0].eval('gameState');
  assert('双端: 房主创建对局', Boolean(hostState?.version === 10 && serverRooms['123456']?.game));
  assert('双端: 客端加载对局', Boolean(clients[1].eval('gameState')?.version === 10));

  // Host uses 妙手偶得 on guest who holds 无法选中.
  clients[0].eval(`(() => {
    gameState.status = 'PLAYING';
    gameState.phase = 'PLAY';
    gameState.currentPlayerId = 'p1';
    gameState.pendingSpell = null;
    gameState.pendingAttack = null;
    gameState.pendingRescue = null;
    gameState.round = 1;
    gameState.killUsed = false;
    gameState.players[0].hand = [{ uid: 'steal-mp', type: 'steal', name: '妙手偶得', effect: 'x', suit: '♠', point: 1, pointLabel: 'A' }];
    gameState.players[1].hand = [{ uid: 'unt-mp', type: 'untargetable', name: '无法选中', effect: 'x', suit: '♠', point: 1, pointLabel: 'A' }, { uid: 'k-mp', type: 'kill', name: '杀', effect: 'x', suit: '♠', point: 1, pointLabel: 'A' }];
    gameState.players.forEach((p) => { p.alive = true; p.hp = p.maxHp; });
    selectedCardUid = 'steal-mp';
    selectedTargetId = 'p2';
    currentPlayer = gameState.players[0];
    useStealCard();
    persistGame();
  })()`);
  broadcast();

  const serverPhaseAfterCast = serverRooms['123456']?.game?.phase;
  assert('双端: 房主使用妙手偶得后进入响应', serverPhaseAfterCast === 'RESPONSE', `phase=${serverPhaseAfterCast}`);

  // Guest (target) accepts the effect; this save must be accepted by the server.
  clients[1].eval(`(() => {
    currentPlayer = gameState.players.find((p) => p.id === 'p2');
    acceptSpellEffect();
    persistGame();
  })()`);

  // Simulate the guest auto-resolving after the response deadline, then saving again.
  clients[1].eval(`(() => {
    gameState.responseDeadline = Date.now() - 1;
    const spellTarget = gameState.pendingSpell && gameState.players.find((player) => player.id === gameState.pendingSpell.currentTargetId);
    if (gameState.phase === 'RESPONSE' && spellTarget?.id === roomSession.playerId && gameState.pendingSpell) {
      const pending = gameState.pendingSpell;
      const id = pending.currentTargetId;
      pending.currentTargetId = null;
      pending.affectedIds.push(id);
      advanceSpellResolution();
      persistGame();
    }
  })()`);

  const serverAfter = serverRooms['123456']?.game;
  const freeze = serverAfter?.phase === 'RESPONSE' && serverAfter?.pendingSpell?.currentTargetId === 'p2';
  record('双端: 目标响应后术卡正常结算(非卡死)', !freeze && serverAfter?.phase === 'PLAY', `server phase=${serverAfter?.phase}, pendingSpell=${JSON.stringify(serverAfter?.pendingSpell)}`);
  if (serverPhaseAfterCast !== 'RESPONSE' || freeze) {
    console.log('AUTHLOG lastReason=', lastReason);
    authLog.forEach((entry, index) => console.log(`AUTHLOG[${index}]`, JSON.stringify(entry)));
  }

  const guestHand = serverAfter?.players?.[0]?.hand?.length;
  assert('双端: 房主成功获得手牌', serverAfter?.players?.[0]?.hand?.length === 1, `hand=${guestHand}`);

  // Guest's local state should also recover to PLAY (not stuck in RESPONSE).
  const guestLocalPhase = clients[1].eval('gameState.phase');
  record('双端: 客端本地状态恢复PLAY', guestLocalPhase === 'PLAY', `guest local phase=${guestLocalPhase}`);

  console.log(`Section 3 two-client simulation done (ok=${ok})`);
}

// ---------------------------------------------------------------------------
// Section 4: random stress driver (single client, deterministic)
// ---------------------------------------------------------------------------
{
  const timers = { seq: 0, order: 0, now: 1750000000000, items: new Map() };
  const players = [
    { id: 'p1', nickname: '玩家一', role: 'host' },
    { id: 'p2', nickname: '玩家二', role: 'player' },
    { id: 'p3', nickname: '玩家三', role: 'player' }
  ];
  const room = makeRoom(players);
  const client = bootClient(room, 'p1', timers, null);
  const set = (code) => client.eval(code);
  const gs = () => client.eval('gameState');

  set(`(() => {
    const seed = 20260824;
    let s = seed >>> 0;
    Math.random = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    gameState.status = 'PLAYING';
    gameState.phase = 'PLAY';
    gameState.currentPlayerId = gameState.players[0].id;
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
    gameState.discardPile = [];
    gameState.deck = [];
    gameState.actionLog = [];
    gameState.players.forEach((player, index) => {
      player.alive = true;
      player.hp = player.maxHp;
      player.hand = [];
      player.weapon = null;
      player.weaponUsage = {};
      player.statusEffects = {};
      player.skillUsage = {};
      player.id = player.id || ('p' + (index + 1));
    });
    const deckCards = [
      { uid: 'k1', type: 'kill', name: '杀', suit: '♠', point: 1, pointLabel: 'A' },
      { uid: 'k2', type: 'kill', name: '杀', suit: '♥', point: 2, pointLabel: '2' },
      { uid: 'k3', type: 'kill', name: '杀', suit: '♣', point: 3, pointLabel: '3' },
      { uid: 'd1', type: 'dodge', name: '闪', suit: '♠', point: 1, pointLabel: 'A' },
      { uid: 'd2', type: 'dodge', name: '闪', suit: '♥', point: 2, pointLabel: '2' },
      { uid: 'h1', type: 'heal', name: '奶', suit: '♣', point: 3, pointLabel: '3' },
      { uid: 'h2', type: 'heal', name: '奶', suit: '♦', point: 4, pointLabel: '4' },
      { uid: 's1', type: 'silence', name: '沉默', suit: '♠', point: 1, pointLabel: 'A' },
      { uid: 'u1', type: 'untargetable', name: '无法选中', suit: '♥', point: 2, pointLabel: '2' },
      { uid: 'w1', type: 'weapon', weaponId: 'hard-bow', name: '硬弓', suit: '♣', point: 3, pointLabel: '3' },
      { uid: 'w2', type: 'weapon', weaponId: 'miao-shou', name: '妙手', suit: '♦', point: 4, pointLabel: '4' },
      { uid: 'b1', type: 'ban', name: '禁令', suit: '♠', point: 1, pointLabel: 'A' },
      { uid: 'm1', type: 'maosheng', name: '茂生', suit: '♥', point: 2, pointLabel: '2' },
      { uid: 'dg1', type: 'death-god', name: '死神', suit: '♣', point: 3, pointLabel: '3' },
      { uid: 'lg1', type: 'love-god', name: '爱神', suit: '♦', point: 4, pointLabel: '4' },
      { uid: 'st1', type: 'steal', name: '妙手偶得', suit: '♠', point: 1, pointLabel: 'A' },
      { uid: 'j1', type: 'judgment', judgmentId: 'heaven-thunder', name: '天雷', condition: 'odd-hand', turnsLeft: 4, suit: '♥', point: 2, pointLabel: '2' },
      { uid: 'dp1', type: 'divine-punish', name: '天罚', suit: '♣', point: 3, pointLabel: '3' }
    ];
    gameState.deck = [...deckCards];
    gameState.players[0].hand = [{ uid: 'seed-a', type: 'kill', name: '杀', suit: '♠', point: 1, pointLabel: 'A' }, { uid: 'seed-b', type: 'steal', name: '妙手偶得', suit: '♠', point: 1, pointLabel: 'A' }, { uid: 'seed-c', type: 'dodge', name: '闪', suit: '♠', point: 1, pointLabel: 'A' }];
    gameState.players[1].hand = [{ uid: 'seed-d', type: 'untargetable', name: '无法选中', suit: '♠', point: 1, pointLabel: 'A' }, { uid: 'seed-e', type: 'kill', name: '杀', suit: '♠', point: 1, pointLabel: 'A' }, { uid: 'seed-f', type: 'heal', name: '奶', suit: '♠', point: 1, pointLabel: 'A' }];
    gameState.players[2].hand = [{ uid: 'seed-g', type: 'dodge', name: '闪', suit: '♠', point: 1, pointLabel: 'A' }];
    currentPlayer = gameState.players[0];
  })()`);

  const alive = () => gs().players.filter((p) => p.alive);
  const turnPlayer = () => gs().players.find((p) => p.id === gs().currentPlayerId);

  function completeDrawing() {
    const s = gs();
    if (s.phase !== 'DRAWING') return;
    const drawingPlayer = s.players.find((p) => p.id === s.drawPlayerId);
    if (s.skipPlayRound === s.round) {
      s.phase = 'DISCARD';
    } else {
      s.phase = 'PLAY';
    }
    s.drawDeadline = null;
    s.turnStartedAt = Date.now();
    s.turnDeadline = Date.now() + 60000;
    if (drawingPlayer) {
      client.eval(`activateSilenceIfNeeded(gameState.players.find((p) => p.id === ${JSON.stringify(drawingPlayer.id)}))`);
    }
  }

  function randomPlayAction(player) {
    const s = gs();
    const others = alive().filter((p) => p.id !== player.id);
    const immuneOthers = others.filter((p) => !client.eval(`isSpellImmune(gameState.players.find((q) => q.id === ${JSON.stringify(p.id)}))`));
    const usable = player.hand.filter((c) => {
      if (c.type === 'kill') return true;
      if (c.type === 'heal') return player.hp < player.maxHp;
      if (['silence', 'ban', 'death-god', 'steal'].includes(c.type)) return immuneOthers.length > 0;
      if (c.type === 'love-god') return alive().length >= 2;
      return true;
    });
    if (!usable.length) return 'pass';
    const pick = usable[Math.floor(Math.random() * usable.length)];
    client.eval(`selectedCardUid = ${JSON.stringify(pick.uid)}; selectedTargetId = null; selectedSecondaryTargetId = null;`);
    if (pick.type === 'kill') {
      const target = others[Math.floor(Math.random() * others.length)];
      client.eval(`selectedTargetId = ${JSON.stringify(target.id)}`);
      client.eval(`playKill()`);
    } else if (['silence', 'ban', 'death-god', 'steal'].includes(pick.type)) {
      const target = immuneOthers[Math.floor(Math.random() * immuneOthers.length)];
      client.eval(`selectedTargetId = ${JSON.stringify(target.id)}`);
      const fn = { silence: 'useSilenceCard', ban: 'useBanCard', 'death-god': 'useDeathGodCard', steal: 'useStealCard' }[pick.type];
      client.eval(`${fn}()`);
    } else if (pick.type === 'love-god') {
      const a = alive()[Math.floor(Math.random() * alive().length)];
      let b = alive()[Math.floor(Math.random() * alive().length)];
      if (b.id === a.id) b = alive().find((p) => p.id !== a.id) || b;
      client.eval(`selectedTargetId = ${JSON.stringify(a.id)}; selectedSecondaryTargetId = ${JSON.stringify(b.id)}`);
      client.eval('useLoveGodCard()');
    } else if (pick.type === 'weapon') {
      client.eval('equipCard()');
    } else {
      const fn = {
        heal: 'useHealCard',
        maosheng: 'useMaoshengCard',
        judgment: 'useJudgmentCard',
        'divine-punish': 'useDivinePunishCard'
      }[pick.type];
      client.eval(`${fn}()`);
    }
  }

  function checkConsistency(step) {
    const s = gs();
    const uids = [];
    s.players.forEach((p) => {
      p.hand.forEach((c) => uids.push('hand:' + c.uid));
      if (p.weapon) uids.push('weapon:' + p.weapon.uid);
    });
    (s.activeJudgments || []).forEach((j) => uids.push('judge:' + j.uid));
    const dup = uids.filter((u, i) => uids.indexOf(u) !== i);
    assert(`stress#${step}: 在场卡牌uid唯一`, dup.length === 0, dup.join(','));
    assert(`stress#${step}: 阶段合法`, ['PLAY', 'DRAWING', 'DISCARD', 'RESPONSE', 'DYING', 'ENDED'].includes(s.phase), `phase=${s.phase}`);
    s.players.forEach((p) => {
      assert(`stress#${step}: hp范围`, p.hp >= 0 && p.hp <= p.maxHp, `${p.nickname} hp=${p.hp}`);
      assert(`stress#${step}: 存活一致性`, p.alive === (p.hp > 0) || s.status === 'ENDED', `${p.nickname} alive=${p.alive} hp=${p.hp}`);
    });
    if (s.pendingSpell) assert(`stress#${step}: spell→RESPONSE`, s.phase === 'RESPONSE', `phase=${s.phase}`);
    if (s.pendingAttack) assert(`stress#${step}: attack→RESPONSE`, s.phase === 'RESPONSE', `phase=${s.phase}`);
    if (s.pendingRescue) assert(`stress#${step}: rescue→DYING`, s.phase === 'DYING', `phase=${s.phase}`);
    if (!s.pendingSpell && !s.pendingAttack && !s.pendingRescue && s.status !== 'ENDED') {
      assert(`stress#${step}: 无pending时非RESPONSE/DYING`, !['RESPONSE', 'DYING'].includes(s.phase), `phase=${s.phase}`);
    }
  }

  let guard = 0;
  for (let step = 1; step <= 400; step += 1) {
    const s = gs();
    if (s.status === 'ENDED') break;
    if (guard++ > 10000) { record('stress: 步数守卫', false, 'guard exceeded'); break; }
    if (s.phase === 'DRAWING') {
      completeDrawing();
      checkConsistency(step);
      continue;
    }
    const player = turnPlayer();
    if (!player) { record(`stress#${step}: 存在当前玩家`, false); break; }
    if (s.phase === 'RESPONSE') {
      const pendingAttack = s.pendingAttack;
      const pendingSpell = s.pendingSpell;
      const isAttackTarget = pendingAttack && pendingAttack.targetId === player.id;
      const isSpellTarget = pendingSpell && pendingSpell.currentTargetId === player.id;
      const responder = s.players.find((p) => p.id === (s.pendingAttack?.targetId || s.pendingSpell?.currentTargetId));
      if (responder) client.eval(`currentPlayer = gameState.players.find((p) => p.id === ${JSON.stringify(responder.id)})`);
      const activeResponder = responder || player;
      if (isSpellTarget) {
        const unt = activeResponder.hand.find((c) => c.type === 'untargetable');
        if (unt && Math.random() < 0.5) {
          client.eval(`selectedCardUid = ${JSON.stringify(unt.uid)}`);
          client.eval('useUntargetableForSpell()');
        } else {
          client.eval('acceptSpellEffect()');
        }
      } else if (isAttackTarget) {
        const dodge = activeResponder.hand.find((c) => c.type === 'dodge');
        if (dodge && Math.random() < 0.6) {
          client.eval(`selectedCardUid = ${JSON.stringify(dodge.uid)}`);
          client.eval('respondDodge()');
        } else {
          client.eval('takeDamage()');
        }
      } else {
        client.eval(`directPass(gameState.players.find((p) => p.id === ${JSON.stringify(player.id)}))`);
      }
      checkConsistency(step);
      continue;
    }
    if (s.phase === 'DYING') {
      const rescuer = s.players.find((p) => p.id === s.pendingRescue?.targetId);
      if (rescuer) client.eval(`currentPlayer = gameState.players.find((p) => p.id === ${JSON.stringify(rescuer.id)})`);
      const activeRescuer = rescuer || player;
      if (s.pendingRescue?.targetId === activeRescuer.id) {
        const heal = activeRescuer.hand.find((c) => c.type === 'heal');
        if (heal && Math.random() < 0.7) {
          client.eval(`selectedCardUid = ${JSON.stringify(heal.uid)}`);
          client.eval('useRescueHeal()');
        } else {
          client.eval('resolveDying(false)');
        }
      } else {
        client.eval(`directPass(gameState.players.find((p) => p.id === ${JSON.stringify(player.id)}))`);
      }
      checkConsistency(step);
      continue;
    }
    if (s.phase === 'DISCARD') {
      if (Math.random() < 0.5) {
        client.eval('directPass(player)');
      } else {
        const excess = Math.max(0, player.hand.length - 5);
        if (excess > 0 && player.hand.length) {
          const discards = player.hand.slice(0, excess).map((c) => c.uid);
          client.eval(`selectedDiscardUids = new Set(${JSON.stringify(discards)})`);
          client.eval('discardSelected()');
        } else {
          client.eval(`directPass(gameState.players.find((p) => p.id === ${JSON.stringify(player.id)}))`);
        }
      }
      checkConsistency(step);
      continue;
    }
    if (s.phase === 'PLAY') {
      const action = randomPlayAction(player);
      if (action === 'pass' || Math.random() < 0.12) {
        client.eval('directPass(player)');
      }
      checkConsistency(step);
    }
  }
  console.log('Section 4 stress driver done');
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
let failures = 0;
results.forEach((r) => {
  if (!r.ok) failures += 1;
  if (!r.ok) console.log(`FAIL  ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
});
console.log(`\n${results.length - failures}/${results.length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
