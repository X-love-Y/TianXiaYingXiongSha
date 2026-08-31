'use strict';
// P0 房间生命周期验证：房主断线超时转移 + 再来一局(仅房主、仅结束后) + 解散房间(仅房主)。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webaigame-lifecycle-'));
const roomsFile = path.join(tempDir, 'rooms.json');
const port = 8337;
const root = path.join(__dirname, '..');

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitFor(predicate, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      Promise.resolve(predicate()).then((ok) => {
        if (ok) { clearInterval(timer); resolve(); }
        else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timeout')); }
      }).catch(() => {});
    }, 40);
  });
}

function startServer() {
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
  return { child, getOut: () => out };
}

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
  const server = startServer();
  await waitFor(() => /prototype server/.test(server.getOut()), 8000);

  const now = Date.now();
  const roomCode = '876543';
  const room = {
    roomCode,
    createdAt: now,
    phase: 'PLAYING',
    revision: 0,
    players: [
      { id: 'p1', nickname: '离线房主', role: 'host', lastSeen: now - (61 * 1000) },
      { id: 'p2', nickname: '最早在线', role: 'guest', lastSeen: now },
      { id: 'p3', nickname: '在线三', role: 'guest', lastSeen: now },
      { id: 'p4', nickname: '在线四', role: 'guest', lastSeen: now }
    ]
  };
  let put = await request('PUT', '/api/rooms', { rooms: { [roomCode]: room } });
  if (put.status !== 200) throw new Error(`PUT failed: ${put.status} ${put.body}`);

  // 房主已离线 > 60s，第二拍（serverGameLoop 每 250ms）应转移房主给最早在线玩家 p2。
  await waitFor(async () => {
    const get = await request('GET', '/api/rooms');
    const r = JSON.parse(get.body).rooms[roomCode];
    const host = r?.players?.find((p) => p.role === 'host');
    return host && host.id === 'p2';
  }, 4000);
  let get = await request('GET', '/api/rooms');
  let current = JSON.parse(get.body).rooms[roomCode];
  let hostRole = current.players.find((p) => p.role === 'host');
  if (hostRole.id !== 'p2') throw new Error('房主未转移给最早在线玩家 p2');
  console.log('PASS 房主断线超时转移到最早在线玩家：p2');

  // 只有 ENDED 才能再来一局；当前 PLAYING 应拒绝。
  let rematch = await request('POST', `/api/rooms/${roomCode}/rematch`, { playerId: 'p2' });
  if (rematch.status !== 409) throw new Error(`非结束再来一局应 409，实际 ${rematch.status}`);
  console.log('PASS 对局未结束时再来一局被拒绝(409)');

  // 手动把房间置为 ENDED（模拟服务端结算后），再用非房主发起应 409。
  // 此时房主已转移为 p2，由 p2 以 actorPlayerId 身份提交变更。
  current.phase = 'ENDED';
  const currentRev = current.revision || 0;
  put = await request('PUT', '/api/rooms', {
    changes: { [roomCode]: current }, knownRevisions: { [roomCode]: currentRev }, actorPlayerId: 'p2'
  });
  if (put.status !== 200) throw new Error(`标记 ENDED 失败: ${put.status} ${put.body}`); 

  rematch = await request('POST', `/api/rooms/${roomCode}/rematch`, { playerId: 'p3' });
  if (rematch.status !== 409) throw new Error(`非房主再来一局应 409，实际 ${rematch.status}`);
  console.log('PASS 非房主发起再来一局被拒绝(409)');

  // 房主 p2 发起再来一局：房间应复位到 CUSTOMIZING 且清除对局产物。
  rematch = await request('POST', `/api/rooms/${roomCode}/rematch`, { playerId: 'p2' });
  if (rematch.status !== 200) throw new Error(`房主再来一局应 200，实际 ${rematch.status} ${rematch.body}`);
  const rematchRoom = JSON.parse(rematch.body).room;
  if (rematchRoom.phase !== 'CUSTOMIZING' || rematchRoom.game || rematchRoom.finalHeroes) {
    throw new Error(`再来一局复位失败: phase=${rematchRoom.phase} game=${!!rematchRoom.game}`);
  }
  console.log('PASS 房主再来一局：房间复位到 CUSTOMIZING');

  // 解散房间：非房主应 409。
  let disband = await request('POST', `/api/rooms/${roomCode}/disband`, { playerId: 'p3' });
  if (disband.status !== 409) throw new Error(`非房主解散应 409，实际 ${disband.status}`);
  // 房主解散应 200 且房间从服务器移除。
  disband = await request('POST', `/api/rooms/${roomCode}/disband`, { playerId: 'p2' });
  if (disband.status !== 200) throw new Error(`房主解散应 200，实际 ${disband.status} ${disband.body}`);
  get = await request('GET', '/api/rooms');
  if (JSON.parse(get.body).rooms[roomCode]) throw new Error('解散后房间仍存在');
  console.log('PASS 房主解散房间：房间已移除');

  server.child.kill('SIGTERM');
  await wait(300);
  console.log('ALL PASS');
  process.exit(0);
}

run().catch((error) => {
  console.error('FAIL', error.message);
  process.exit(1);
});
