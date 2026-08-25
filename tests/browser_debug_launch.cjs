'use strict';
const cdp = require('./cdp.cjs');
const path = require('path');

const CDP_PORT = 9224;
const BASE = 'http://49.233.20.220:8000';
const ROOM_CODE = String(100000 + Math.floor(Math.random() * 900000));
const ROOM = {
  roomCode: ROOM_CODE,
  schemaVersion: 1,
  revision: 0,
  password: '123456',
  mode: 'survival',
  duration: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  phase: 'PLAYING',
  players: [
    { id: 'p1', nickname: '玩家一', role: 'host', ready: true },
    { id: 'p2', nickname: '玩家二', role: 'guest', ready: true }
  ],
  heroGeneration: { status: 'READY' },
  generatedHeroes: {
    p1: { heroName: '玩家一的英雄', maxHpBonus: 0, flavorText: '测试英雄' },
    p2: { heroName: '玩家二的英雄', maxHpBonus: 0, flavorText: '测试英雄' }
  }
};

async function main() {
  const { chrome } = await cdp.launchChrome(CDP_PORT);
  try {
    const tab = await cdp.newTab(CDP_PORT, 'about:blank');
    const client = await cdp.connectToTab(tab);
    const errors = [];
    client.on('Runtime.exceptionThrown', (params) => errors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text));
    client.on('Log.entryAdded', (params) => { if (params.entry.level === 'error') errors.push(params.entry.text); });
    await client.send('Log.enable');
    await cdp.navigate(client, `${BASE}/lobby.html`);
    const putResult = await cdp.evalJs(client, `(async () => {
      const room = ${JSON.stringify(ROOM)};
      const res = await fetch('/api/rooms', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: { '${ROOM_CODE}': room }, knownRevisions: {}, actorPlayerId: 'p1' })
      });
      const payload = await res.json();
      return { status: res.status, payload };
    })()`, true);
    console.log('PUT', JSON.stringify(putResult, null, 2));
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const afterPut = await cdp.evalJs(client, `(() => {
      const rooms = JSON.parse(localStorage.getItem('heroKillLocalRooms') || '{}');
      return { hasRoom: Boolean(rooms['${ROOM_CODE}']), room: rooms['${ROOM_CODE}'] || null, href: location.href };
    })()`);
    console.log('AFTER PUT LOCAL', JSON.stringify({ hasRoom: afterPut.hasRoom, href: afterPut.href }, null, 2));
    await cdp.evalJs(client, `(() => {
      sessionStorage.setItem('heroKillRoomSession', JSON.stringify({ roomCode: '${ROOM_CODE}', playerId: 'p1' }));
    })()`);
    await cdp.navigate(client, `${BASE}/game.html`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const info = await cdp.evalJs(client, `(() => ({
      href: location.href,
      session: sessionStorage.getItem('heroKillRoomSession'),
      hasLocalRoom: Boolean(JSON.parse(localStorage.getItem('heroKillLocalRooms') || '{}')['${ROOM_CODE}']),
      localRoomPhase: JSON.parse(localStorage.getItem('heroKillLocalRooms') || '{}')['${ROOM_CODE}']?.phase,
      hasGame: typeof gameState !== 'undefined' && gameState !== null,
      gamePhase: (typeof gameState !== 'undefined' && gameState) ? gameState.phase : null
    }))()`);
    console.log('INFO', JSON.stringify(info, null, 2));
    console.log('ERRORS', JSON.stringify(errors, null, 2));
    await cdp.screenshot(client, path.join(__dirname, 'shots', 'debug-launch.png'));
  } finally {
    chrome.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
