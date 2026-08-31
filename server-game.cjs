'use strict';
// 服务器权威对局引擎（Milestone 1）
// 复用 game.html 中已有的对局规则，通过 VM 在服务端运行唯一一份游戏状态，
// 客户端只发送 RPC，服务器推进回合并广播增量结果，彻底避免“各客户端各跑一套逻辑”。
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const roomStorageKey = 'heroKillLocalRooms';
const sessionStorageKey = 'heroKillRoomSession';

let cachedScript = null;
function loadGameScript() {
  if (cachedScript) return cachedScript;
  const html = fs.readFileSync(path.join(__dirname, 'game.html'), 'utf8');
  const matches = [...html.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/g)];
  cachedScript = matches[matches.length - 1][1];
  return cachedScript;
}

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((name) => this.set.add(name)); }
  remove(...names) { names.forEach((name) => this.set.delete(name)); }
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
  set innerHTML(value) { this._innerHTML = value; }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  querySelectorAll() { return []; }
  querySelector() { return null; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  play() { return Promise.resolve(); }
  click() {}
}

function makeSandbox(room) {
  const roomCode = room.roomCode;
  const hostId = (room.players.find((player) => player.role === 'host') || room.players[0]).id;
  const localStore = new Map();
  localStore.set(roomStorageKey, JSON.stringify({ [roomCode]: room }));
  const sessionStore = new Map();
  sessionStore.set(sessionStorageKey, JSON.stringify({ roomCode, playerId: hostId }));

  const timers = { seq: 0, items: new Map(), now: 0, order: 0 };
  const elements = new Map();
  const makeEl = (id) => {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  };

  const sandbox = {
    console, Math, Date, JSON, Object, Array, Map, Set, Promise, String, Number, Boolean, RegExp, Error,
    parseInt, parseFloat, isNaN,
    // 服务器端复用该引擎用于“推进对局”（SERVER_AUTH=false）；浏览器端默认 true（瘦客户端）。
    __SERVER_AUTH: false,
    setTimeout: (fn, ms = 0) => { const id = ++timers.seq; timers.items.set(id, { fn, ms, interval: false, at: timers.now + ms, order: timers.order++ }); return id; },
    setInterval: (fn, ms = 0) => { const id = ++timers.seq; timers.items.set(id, { fn, ms, interval: true, at: timers.now + ms, order: timers.order++ }); return id; },
    clearTimeout: (id) => timers.items.delete(id),
    clearInterval: (id) => timers.items.delete(id),
    localStorage: {
      getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
      setItem: (key, value) => localStore.set(key, String(value)),
      removeItem: (key) => localStore.delete(key)
    },
    sessionStorage: {
      getItem: (key) => (sessionStore.has(key) ? sessionStore.get(key) : null),
      setItem: (key, value) => sessionStore.set(key, String(value)),
      removeItem: (key) => sessionStore.delete(key)
    },
    document: {
      getElementById: (id) => makeEl(id),
      querySelector: () => makeEl('__query__'),
      querySelectorAll: () => [],
      addEventListener: () => {}
    },
    window: {
      addEventListener: () => {},
      location: { href: '', replace: () => {} },
      EventSource: class { constructor() {} close() {} addEventListener() {} },
      HeroKillNet: null
    },
    location: { href: '', replace: () => {} }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(loadGameScript(), ctx, { filename: 'game.html' });
  return { ctx, eval: (code) => vm.runInContext(code, ctx, { filename: 'server-game.js' }), timers };
}

function json(value) { return JSON.stringify(value); }
function q(value) { return JSON.stringify(String(value || '')); }

class GameSession {
  constructor(room) {
    this.roomCode = room.roomCode;
    this.sandbox = makeSandbox(room);
    this.eval = this.sandbox.eval;
    this.lastSnapshot = null;
    // 服务器权威：脚本内的 loadOrCreateGame 已不再本地建局（SERVER_AUTH=true），
    // 因此这里由服务端显式调用 createGame 建立唯一对局状态。
    // 必须先让 roomData 指向当前房间：makePlayer / refreshPlayerHeroes 用 getGeneratedHero(roomData, ...)
    // 把 finalHeroes 里的主/副/特技挂到玩家的 hero 上；否则服务器权威模式下技能不会生效。
    this.eval(`roomData = ${JSON.stringify(room)}; localStorage.setItem(${q('heroKillLocalRooms')}, JSON.stringify({ [${q(room.roomCode)}]: ${JSON.stringify(room)} }));`);
    if (!this.eval('gameState && gameState.status === "PLAYING"')) {
      this.eval(`gameState = createGame(${JSON.stringify(room)});`);
    }
    this.eval('if (roomData) { roomData.game = gameState; localStorage.setItem("heroKillLocalRooms", JSON.stringify({ [roomData.roomCode]: roomData })); }');
    this.initialized = Boolean(this.eval('gameState && gameState.status === "PLAYING"'));
  }

  // 当前权威状态快照（可序列化，不含函数）
  snapshot() {
    return JSON.parse(this.eval('JSON.stringify(gameState)'));
  }

  // 允许该玩家在当前阶段行动（校验：是否轮到 / 是否是其响应目标）
  canAct(playerId) {
    return Boolean(this.eval(`(() => {
      const players = gameState.players;
      const p = players.find((x) => x.id === ${q(playerId)});
      if (!p || !p.alive) return false;
      if (gameState.phase === 'RESPONSE') {
        return gameState.pendingAttack?.targetId === p.id || gameState.pendingSpell?.currentTargetId === p.id;
      }
      if (gameState.phase === 'DYING') return gameState.pendingRescue?.targetId === p.id;
      return gameState.currentPlayerId === p.id && gameState.phase === 'PLAY' || gameState.currentPlayerId === p.id && gameState.phase === 'DISCARD';
    })()`));
  }

  _setSelection(event) {
    this.eval(`currentPlayer = gameState.players.find((p) => p.id === ${q(event.playerId)}) || gameState.players[0];`);
    this.eval(`selectedCardUid = ${event.cardUid ? q(event.cardUid) : 'null'};`);
    this.eval(`selectedTargetId = ${event.targetId ? q(event.targetId) : 'null'};`);
    this.eval(`selectedSecondaryTargetId = ${event.secondaryTargetId ? q(event.secondaryTargetId) : 'null'};`);
    if (Array.isArray(event.uids)) this.eval(`selectedDiscardUids = new Set(${json(event.uids)});`);
  }

  act(event) {
    const type = String(event?.type || '');
    const cardUid = event?.cardUid ? String(event.cardUid) : null;
    const playerId = String(event?.playerId || '');
    this._setSelection(event);
    const ev = this.eval;

    const commit = (call) => ev(call);

    if (type === 'pass') return commit(`directPass(currentPlayer);`);
    if (type === 'end-turn') return commit(`directPass(currentPlayer);`);
    if (type === 'dodge') return commit(`respondDodge();`);
    if (type === 'take-damage') return commit(`takeDamage();`);
    if (type === 'untargetable') return commit(`useUntargetableForSpell();`);
    if (type === 'accept-spell') return commit(`acceptSpellEffect();`);
    if (type === 'rescue-heal') return commit(`useRescueHeal();`);
    if (type === 'refuse-rescue') return commit(`takeDamage();`);
    if (type === 'doom') {
      return commit(`useDoomCard(currentPlayer, gameState.players.find((p) => p.id === ${q(event.targetId)}));`);
    }
    if (type === 'manual-discard') return commit(`startManualDiscard();`);
    if (type === 'discard') return commit(`discardSelected();`);
    if (type === 'play') {
      if (!cardUid) return commit('addLog("RPC 缺少 cardUid"); false;');
      const cardType = ev(`(currentPlayer.hand.find((c) => c.uid === ${q(cardUid)}) || {}).type || null`);
      const route = {
        kill: 'playKill()',
        heal: 'useHealCard()',
        dodge: 'useDodgeAsHeal()',
        silence: 'useSilenceCard()',
        untargetable: 'useUntargetableCard()',
        weapon: 'equipCard()',
        judgment: 'useJudgmentCard()',
        'divine-punish': 'useDivinePunishCard()',
        maosheng: 'useMaoshengCard()',
        ban: 'useBanCard()',
        'death-god': 'useDeathGodCard()',
        steal: 'useStealCard()',
        'love-god': 'useLoveGodCard()',
        special: 'useSpecialCard()'
      };
      if (route[cardType]) return commit(route[cardType]);
      return commit('addLog("RPC 未知卡牌类型"); false;');
    }
    return commit('addLog("RPC 未知动作类型"); false;');
  }

  // 服务器权威推进：处理摸牌/响应/出牌超时，并驱动 demo 回合（如有）。
  tick() {
    if (!this.initialized) return;
    this.eval('tick();');
  }

  // 执行服务器定时器里到期的 setTimeout（用于 demo 机器人等）。
  pumpTimers(now = Date.now()) {
    const { timers } = this.sandbox;
    timers.now = now;
    const due = [];
    timers.items.forEach((item, id) => {
      if (!item.interval && item.at <= now) due.push(id);
    });
    due.forEach((id) => {
      const item = timers.items.get(id);
      if (!item) return;
      timers.items.delete(id);
      try { item.fn(); } catch (error) { console.error('pumpTimers error:', error); }
    });
  }
}

function createSession(room) {
  return new GameSession(room);
}

module.exports = { GameSession, createSession };
