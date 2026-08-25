'use strict';
const cdp = require('./cdp.cjs');

const CDP_PORT = 9229;
const BASE = 'http://127.0.0.1:8000';

function makeRoom(code, status, completed, total) {
  const players = [];
  for (let i = 1; i <= 4; i += 1) {
    players.push({ id: 'p' + i, nickname: '玩家' + '一二三四'[i - 1], role: i === 1 ? 'host' : 'guest', ready: true });
  }
  return {
    roomCode: code,
    schemaVersion: 1,
    revision: 0,
    password: '123456',
    mode: 'survival',
    duration: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'GENERATING',
    players,
    heroGeneration: { status, completedCount: completed, totalCount: total },
    customizations: { p1: { playerId: 'p1', submittedAt: Date.now(), cards: Array.from({ length: 5 }, (_, i) => ({ name: '英雄' + (i + 1), description: '描述' })) } }
  };
}

async function main() {
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const { chrome } = await cdp.launchChrome(CDP_PORT);
  let client = null;
  try {
    const tab = await cdp.newTab(CDP_PORT, 'about:blank');
    client = await cdp.connectToTab(tab);
    await cdp.enableFetchBlock(client, 'network.js');
    await cdp.navigate(client, `${BASE}/lobby.html`);
    await cdp.evalJs(client, `(() => {
      localStorage.setItem('heroKillLocalRooms', JSON.stringify({ '${code}': ${JSON.stringify(makeRoom(code, 'RUNNING', 3, 20))} }));
      sessionStorage.setItem('heroKillRoomSession', JSON.stringify({ roomCode: '${code}', playerId: 'p1' }));
    })()`);
    await cdp.navigate(client, `${BASE}/customize.html`);
    await cdp.waitFor(client, `!document.getElementById('generatingPanel').hidden`, 10000);
    const info = await cdp.evalJs(client, `(() => ({
      panelVisible: !document.getElementById('generatingPanel').hidden,
      count: document.getElementById('generatingCount').textContent,
      formHidden: document.getElementById('customizeForm').hidden
    }))()`);
    console.log('DIAG', JSON.stringify(info));
    const ok = info.panelVisible && info.count.includes('3 / 20') && info.formHidden === true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  AI生成等待界面（进度3/20、表单隐藏）  ${JSON.stringify(info)}`);
    await cdp.screenshot(client, 'tests/shots/generating-panel.png');
  } finally {
    if (client) await client.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    chrome.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
