'use strict';
// 验证：离线检测 + 对局中接管空缺席位 + 对局中禁止直接加人。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webaigame-takeover-'));
const roomsFile = path.join(tempDir, 'rooms.json');
const port = 8327;
const root = path.join(__dirname, '..');

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitFor(predicate, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timeout')); }
    }, 50);
  });
}

const child = spawn(process.execPath, ['dev-server.cjs'], {
  cwd: root,
  env: {
    ...process.env,
    WEB_AI_GAME_PORT: String(port),
    WEB_AI_GAME_HOST: '127.0.0.1',
    WEB_AI_GAME_ROOMS_FILE: roomsFile
  }
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

function request(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: data ? { 'Content-Type': 'application/json' } : {}
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  await waitFor(() => /prototype server/.test(out), 8000);

  const roomCode = '765432';
  const now = Date.now();
  const room = {
    roomCode,
    createdAt: now,
    phase: 'PLAYING',
    revision: 0,
    players: [
      { id: 'p1', nickname: '房主', role: 'host', lastSeen: now },
      { id: 'p2', nickname: '离线的', role: 'guest', lastSeen: now - 120000 },
      { id: 'p3', nickname: '在线三', role: 'guest', lastSeen: now },
      { id: 'p4', nickname: '在线四', role: 'guest', lastSeen: now }
    ]
  };
  const put = await request('PUT', '/api/rooms', { rooms: { [roomCode]: room } });
  if (put.status !== 200) throw new Error(`PUT failed: ${put.status} ${put.body}`);

  // 在线状态检测
  const get = await request('GET', '/api/rooms');
  const gotten = JSON.parse(get.body).rooms[roomCode];
  const onlineMap = Object.fromEntries(gotten.players.map((p) => [p.id, p.online]));
  if (onlineMap.p2 !== false) throw new Error('p2 应显示离线');
  if (onlineMap.p1 !== true || onlineMap.p3 !== true || onlineMap.p4 !== true) throw new Error('在线玩家应显示在线');
  console.log('PASS 在线/离线检测正确');

  // 接管空缺席位：应接管 p2
  const t1 = await request('POST', `/api/rooms/${roomCode}/takeover`, { nickname: '接管人' });
  const tp = JSON.parse(t1.body);
  if (t1.status !== 200 || tp.ok !== true || tp.playerId !== 'p2') {
    throw new Error(`接管应返回 p2，实际 ${t1.status} ${t1.body}`);
  }
  console.log('PASS 离线玩家席位被接管：playerId=p2');

  // 接管后该席位在线，再次接管应无空位
  const t2 = await request('POST', `/api/rooms/${roomCode}/takeover`, { nickname: '再来' });
  if (t2.status !== 409) throw new Error(`再次接管应 409，实际 ${t2.status}`);
  console.log('PASS 无空位时接管被拒绝(409)');

  // 对局中直接加人应被拒绝（防止出现第 5 人）
  const bad = await request('PUT', '/api/rooms', {
    changes: { [roomCode]: { ...gotten, players: [...gotten.players, { id: 'p5', nickname: '新加入', role: 'guest' }] } },
    knownRevisions: { [roomCode]: gotten.revision || 0 },
    actorPlayerId: 'p1'
  });
  if (bad.status !== 409) throw new Error(`对局中加人应 409，实际 ${bad.status} ${bad.body}`);
  console.log('PASS 对局中禁止直接加入新玩家(409)');

  child.kill('SIGTERM');
  await wait(300);
  console.log('ALL PASS');
  process.exit(0);
}

run().catch((error) => {
  console.error('FAIL', error.message);
  child.kill('SIGKILL');
  process.exit(1);
});
