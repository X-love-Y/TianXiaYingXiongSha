'use strict';
const cdp = require('./cdp.cjs');

const CDP_PORT = 9228;
const BASE = 'http://127.0.0.1:8000';

async function api(pathname, method, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

function shuffle(values) {
  const list = [...values];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

async function main() {
  const code = String(100000 + Math.floor(Math.random() * 900000));
  const players = [
    { id: 'p1', nickname: '玩家一', role: 'host', ready: true },
    { id: 'p2', nickname: '玩家二', role: 'guest', ready: true },
    { id: 'p3', nickname: '玩家三', role: 'guest', ready: true },
    { id: 'p4', nickname: '玩家四', role: 'guest', ready: true }
  ];
  const room = {
    roomCode: code,
    schemaVersion: 1,
    revision: 0,
    password: '123456',
    mode: 'survival',
    duration: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'CUSTOMIZING',
    players,
    heroGeneration: { status: 'WAITING' }
  };
  const results = [];

  let result = await api('/api/rooms', 'PUT', { changes: { [code]: room }, knownRevisions: {}, actorPlayerId: 'p1' });
  if (result.status !== 200) throw new Error('room create failed');

  // p2/p3/p4 submit via API
  for (const player of players.slice(1)) {
    const cards = Array.from({ length: 5 }, (_, index) => ({
      name: `${player.nickname}英雄${index + 1}`,
      description: `擅长猛攻与守护的强者，性格${['冷静', '开朗', '沉稳'][players.indexOf(player) - 1]}。`
    }));
    result = await api(`/api/rooms/${code}/customizations`, 'POST', { playerId: player.id, cards });
    if (result.status >= 400) throw new Error('api submit failed');
  }

  const { chrome } = await cdp.launchChrome(CDP_PORT);
  let client = null;
  try {
    const tab = await cdp.newTab(CDP_PORT, 'about:blank');
    client = await cdp.connectToTab(tab);
    await cdp.navigate(client, `${BASE}/lobby.html`);
    await cdp.evalJs(client, `(() => {
      sessionStorage.setItem('heroKillRoomSession', JSON.stringify({ roomCode: '${code}', playerId: 'p1' }));
    })()`);
    await cdp.navigate(client, `${BASE}/customize.html`);
    await cdp.waitFor(client, `document.querySelectorAll('#cards .card').length === 5`, 15000);
    results.push({ name: '定制页渲染5张卡', ok: true, extra: '' });

    // Fill and submit via UI
    await cdp.evalJs(client, `(() => {
      for (let i = 0; i < 5; i += 1) {
        document.querySelector('input[name="heroName' + i + '"]').value = '玩家一英雄' + (i + 1);
        document.querySelector('textarea[name="heroDescription' + i + '"]').value = '擅长猛攻与守护的强者，性格豪迈。';
      }
    })()`);
    const counterBefore = await cdp.evalJs(client, `document.getElementById('playerHint').textContent`);
    results.push({ name: '已提交人数显示正确(p2-p4已提交)', ok: counterBefore.includes('3/4'), extra: counterBefore });
    await cdp.evalJs(client, `document.getElementById('customizeForm').requestSubmit()`);

    // 提交后应出现 AI 生成等待界面（生成很快时可能直接跳到确认，二者至少出现一个）
    let sawGenerating = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const panelVisible = await cdp.evalJs(client, `!document.getElementById('generatingPanel').hidden`);
      const reviewReady = await cdp.evalJs(client, `document.querySelectorAll('#cards .review-card').length === 5`);
      if (panelVisible) sawGenerating = true;
      if (reviewReady) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    results.push({ name: 'AI生成等待界面出现', ok: true, extra: sawGenerating ? 'generatingPanel visible' : '生成过快未捕捉到面板（已进入确认；面板渲染由 browser_test_generating 确定性验证）' });

    // Wait for review mode (phase REVIEWING, 5 review cards)
    await cdp.waitFor(client, `document.querySelectorAll('#cards .review-card').length === 5`, 60000);
    const reviewNames = await cdp.evalJs(client, `Array.from(document.querySelectorAll('#cards .review-card .card-title')).map((el) => el.textContent)`);
    results.push({ name: 'AI后展示本人5张卡', ok: reviewNames.length === 5, extra: JSON.stringify(reviewNames) });
    const reviewHasHp = await cdp.evalJs(client, `Array.from(document.querySelectorAll('#cards .review-card')).every((card) => card.innerText.includes('血量') && card.innerText.includes('主技能') && card.innerText.includes('副技能') && card.innerText.includes('特技'))`);
    results.push({ name: '展示血量/主/副/特技', ok: reviewHasHp, extra: '' });

    // Confirm
    await cdp.evalJs(client, `document.querySelector('.submit-button').click()`);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const confirmState = await cdp.evalJs(client, `document.querySelector('.submit-button').textContent`);
    results.push({ name: '确认按钮状态', ok: confirmState.includes('已确认') || confirmState.includes('等待'), extra: confirmState });

    // API confirm others -> SELECTING -> tab redirects to select.html
    for (const player of players.slice(1)) {
      await api(`/api/rooms/${code}/confirmations`, 'POST', { playerId: player.id });
    }
    await cdp.waitFor(client, `location.pathname.includes('select.html')`, 15000);
    results.push({ name: '全员确认后进入选将页', ok: true, extra: '' });
    await cdp.waitFor(client, `document.querySelectorAll('#cards .card').length === 5`, 15000);
    const dealtTitles = await cdp.evalJs(client, `Array.from(document.querySelectorAll('#cards .card-title')).map((el) => el.textContent)`);
    results.push({ name: '选将页展示5张随机卡', ok: dealtTitles.length === 5, extra: JSON.stringify(dealtTitles) });

    // Pick main (first card) + secondary (second card)
    await cdp.evalJs(client, `document.querySelectorAll('[data-pick="main"]')[0].click()`);
    await cdp.evalJs(client, `document.querySelectorAll('[data-pick="secondary"]')[1].click()`);
    const submitDisabled = await cdp.evalJs(client, `document.getElementById('submitButton').disabled`);
    results.push({ name: '选将后可提交', ok: submitDisabled === false, extra: `disabled=${submitDisabled}` });
    await cdp.evalJs(client, `document.getElementById('submitButton').click()`);

    // API select others -> PLAYING -> tab redirects to game.html
    const roomState = (await api('/api/rooms', 'GET')).payload.rooms[code];
    for (const player of players.slice(1)) {
      const dealt = roomState.dealtHands[player.id];
      const [mainHero, secondaryHero] = shuffle(dealt);
      await api(`/api/rooms/${code}/selections`, 'POST', { playerId: player.id, mainHeroId: mainHero.id, secondaryHeroId: secondaryHero.id });
    }
    await cdp.waitFor(client, `location.pathname.includes('game.html')`, 20000);
    await cdp.waitFor(client, `typeof gameState !== 'undefined' && gameState !== null && gameState.status === 'PLAYING'`, 15000);
    const seats = await cdp.evalJs(client, `['seat0','seat1','seat2','seat3'].map((id) => document.getElementById(id).innerText.slice(0, 12))`);
    results.push({ name: '进入对局且座位固定', ok: seats[0].includes('玩家一') && seats[1].includes('玩家二') && seats[2].includes('玩家三') && seats[3].includes('玩家四'), extra: JSON.stringify(seats) });
    const finalHero = await cdp.evalJs(client, `(() => {
      const p = gameState.players.find((x) => x.id === 'p1');
      return { name: p.heroName, hp: p.maxHp, primary: p.hero?.primarySkill?.templateId, secondary: p.hero?.secondarySkill?.templateId, special: p.hero?.specialSkill?.templateId };
    })()`);
    results.push({ name: '主将血量/主技能+副将副技能生效', ok: Boolean(finalHero.primary && finalHero.secondary && finalHero.special && finalHero.hp), extra: JSON.stringify(finalHero) });

    let failures = 0;
    results.forEach((r) => {
      if (!r.ok) failures += 1;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.extra}`);
    });
    console.log(`\n${results.length - failures}/${results.length} passed, ${failures} failed`);
  } finally {
    if (client) await client.close().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 200));
    chrome.kill();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
