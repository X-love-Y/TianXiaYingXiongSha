'use strict';
// 验证：房间持久化到磁盘，重启后能恢复（防止服务器重启丢对局）。
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webaigame-persist-'));
const roomsFile = path.join(tempDir, 'rooms.json');
const port = 8317;
const root = path.join(__dirname, '..');

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function waitFor(predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > timeout) { clearInterval(timer); reject(new Error('timeout')); }
    }, 50);
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
  // 第一次启动
  const first = startServer();
  await waitFor(() => /prototype server/.test(first.getOut()), 8000);

  const roomCode = '834217';
  const room = {
    roomCode,
    createdAt: Date.now(),
    players: [{ id: 'p1', nickname: '测试房主', role: 'host', ready: true }],
    phase: 'CUSTOMIZING'
  };
  const put = await request('PUT', '/api/rooms', { rooms: { [roomCode]: room } });
  if (put.status !== 200) throw new Error(`PUT failed: ${put.status} ${put.body}`);

  await wait(1400); // 等 800ms 去抖持久化
  if (!fs.existsSync(roomsFile)) throw new Error('rooms.json 未生成');
  const saved = JSON.parse(fs.readFileSync(roomsFile, 'utf8'));
  if (!saved.rooms || !saved.rooms[roomCode]) throw new Error('持久化结果缺少房间');

  // 优雅退出后重启
  first.child.kill('SIGTERM');
  await wait(600);
  const second = startServer();
  await waitFor(() => /prototype server/.test(second.getOut()), 8000);
  const get = await request('GET', '/api/rooms');
  const payload = JSON.parse(get.body);
  if (!payload.rooms || !payload.rooms[roomCode]) throw new Error('重启后房间未恢复');

  second.child.kill('SIGTERM');
  await wait(400);
  console.log('PASS 房间已持久化，重启后恢复成功');
  process.exit(0);
}

run().catch((error) => {
  console.error('FAIL', error.message);
  process.exit(1);
});
