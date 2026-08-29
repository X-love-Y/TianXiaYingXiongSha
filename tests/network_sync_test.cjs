'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const roomStorageKey = 'heroKillLocalRooms';

function bootNetwork(serverState, serverApply, serverGet) {
  const localStore = new Map();
  const storageListeners = [];
  class FakeEvent { constructor(type, opts){ this.type = type; if (opts) Object.assign(this, opts); } }
  class FakeStorageEvent extends FakeEvent { constructor(type, opts){ super(type, opts); } }
  // 初始本地无房间
  localStore.set(roomStorageKey, JSON.stringify({}));
  const esInstances = [];
  const FakeEventSource = class { constructor(){ esInstances.push(this); } close() {} addEventListener(t, fn){ this[t] = fn; } };
  const sandbox = {
    console, Math, Date, JSON, Object, Array, Map, Set, Promise, String, Number, Boolean, RegExp, Error, parseInt, parseFloat, isNaN,
    setTimeout: (f, ms=0)=>({f,ms}), setInterval: (f, ms=0)=>({f,ms}), clearTimeout:()=>{}, clearInterval:()=>{},
    EventSource: FakeEventSource,
    Event: FakeEvent,
    StorageEvent: FakeStorageEvent,
    fetch: async (url, opts) => {
      if (opts?.method === 'GET') return { ok: true, json: async () => ({ rooms: serverGet() }) };
      if (opts?.method === 'PUT') {
        const payload = JSON.parse(opts.body);
        const res = serverApply(payload);
        if (res.status !== 200) return { ok: false, json: async () => res.payload, status: res.status };
        return { ok: true, json: async () => res.payload };
      }
      return { ok: false, json: async () => ({}), status: 404 };
    },
    localStorage: { getItem:(k)=>localStore.has(k)?localStore.get(k):null, setItem:(k,v)=>localStore.set(k,String(v)), removeItem:(k)=>localStore.delete(k) },
    window: { addEventListener:(t,fn)=>storageListeners.push({t,fn}), dispatchEvent:(ev)=>{ storageListeners.filter(x=>x.t===ev.type).forEach(x=>x.fn(ev)); return true; }, location:{href:'',replace:()=>{}}, EventSource: FakeEventSource },
    location: { protocol: 'http:', href:'' }
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'network.js'), 'utf8'), ctx, { filename: 'network.js' });
  return { ctx, eval:(c)=>vm.runInContext(c,ctx,{filename:'e'}), localStore, storageListeners };
}

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass += 1; console.log('PASS', name); } else { fail += 1; console.log('FAIL', name); } }

function room(code, revision, players) {
  return { roomCode: code, revision, players: players || [{ id: 'p1', nickname: 'A', role: 'host' }], createdAt: Date.now() };
}

// 场景：服务器有一个旧房间 X(revision 5)，客户端刚 create 了一个新房间 A，
// 客户端 lastServerSnapshot 里 X 是 revision 3（过期），一次 PUT 会整批 409。
const serverRooms = { X: room('X', 5) };
let putCount = 0;
const serverApply = (payload) => {
  putCount += 1;
  // 首次整批提交：X 冲突（服务器 revision 5 != 客户端 3）
  if (putCount === 1) return { status: 409, payload: { ok: false, message: '409' } };
  // 重试：接受 A 新建，并保留 X
  const changes = payload.changes || {};
  Object.keys(changes).forEach((code) => {
    if (changes[code] === null) delete serverRooms[code];
    else serverRooms[code] = changes[code];
  });
  return { status: 200, payload: { ok: true, rooms: JSON.parse(JSON.stringify(serverRooms)) } };
};

(async () => {
  const net = bootNetwork(serverRooms, serverApply, () => serverRooms);
  const ev = net.eval;

  await ev(`(async () => {
    const rooms = {};
    rooms['A'] = { roomCode: 'A', revision: 0, players: [{ id: 'me', nickname: 'Me', role: 'host' }], createdAt: Date.now() };
    rooms['X'] = { roomCode: 'X', revision: 3, players: [{ id: 'p1', nickname: 'A', role: 'host' }], createdAt: Date.now() };
    window.__result = await window.HeroKillNet.saveRooms(rooms, { playerId: 'me' });
  })()`);

  const result = ev('window.__result');
  const localRooms = JSON.parse(net.localStore.get(roomStorageKey));
  console.log('put attempts:', putCount);
  check('retried after 409 (>=2 puts)', putCount >= 2);
  check('new room A is in localStorage', Boolean(localRooms.A));
  check('server has room A', Boolean(serverRooms.A));
  check('we did not lose local create intent (A has me)', (localRooms.A?.players||[]).some((p)=>p.id==='me'));
  check('X still present', Boolean(localRooms.X));

  console.log(`\n${pass}/${pass+fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
