'use strict';
// Minimal Chrome DevTools Protocol client using Node built-in WebSocket and fetch.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
          else waiter.resolve(msg.result);
        }
      } else {
        this.events.push(msg);
        const handlers = this.listeners.get(msg.method);
        if (handlers) handlers.forEach((fn) => fn(msg.params));
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const list = this.listeners.get(method) || [];
    list.push(fn);
    this.listeners.set(method, list);
  }

  async close() {
    if (this.ws) this.ws.close();
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function launchChrome(port) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webai-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--window-size=1440,1000',
    '--disable-features=Translate',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  let version = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
      break;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (!version) throw new Error('Chrome remote debugging did not come up');
  return { chrome, userDataDir, version };
}

async function listTabs(port) {
  return fetchJson(`http://127.0.0.1:${port}/json/list`);
}

async function newTab(port, url) {
  return fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
}

async function connectToTab(tab) {
  const client = new CdpClient(tab.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  return client;
}

async function navigate(client, url, timeoutMs = 20000) {
  await client.send('Page.navigate', { url });
  await waitFor(client, `document.readyState === 'complete'`, timeoutMs);
}

// Block requests whose URL contains urlPart by failing them before they reach the network.
async function enableFetchBlock(client, urlPart) {
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  client.on('Fetch.requestPaused', (params) => {
    const requestId = params.requestId;
    if (params.request.url.includes(urlPart)) {
      client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    } else {
      client.send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  });
}

// Evaluate an expression in the page. Returns the value (must be JSON-serializable).
async function evalJs(client, expression, awaitPromise = false) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(`Page exception: ${JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text)}`);
  }
  return result.result?.value;
}

async function waitFor(client, expression, timeoutMs = 15000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await evalJs(client, expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out: ${expression}${lastError ? ` (${lastError.message})` : ''}`);
}

async function screenshot(client, filePath) {
  const result = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(filePath, Buffer.from(result.data, 'base64'));
}

module.exports = { CdpClient, launchChrome, listTabs, newTab, connectToTab, navigate, enableFetchBlock, evalJs, waitFor, screenshot };
