/**
 * 一次性核验脚本：无头 Chrome 打开当前 GUI，等长上下文预算触发件出现，
 * 点开面板、拖到某一档，逐步截图。用完即删。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:14453';
const OUT = process.argv[3] || join(tmpdir(), 'lcb-shots');
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'lcb-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1600,1100',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await response.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch {
      /* 还没起来。 */
    }
    await sleep(250);
  }
  throw new Error('chrome devtools did not start');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.waiting = new Map();
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.waiting.has(message.id)) {
        const { resolve, reject } = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', reject);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text + ' ' + JSON.stringify(result.exceptionDetails.exception?.description ?? ''));
    }
    return result.result.value;
  }
  async shot(name) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' });
    const path = join(OUT, name);
    writeFileSync(path, Buffer.from(result.data, 'base64'));
    return path;
  }
}

const target = await findTarget();
const cdp = new Cdp(target.webSocketDebuggerUrl);
await cdp.ready();
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

const problems = [];
cdp.ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') {
    problems.push(message.params.exceptionDetails.text);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    const text = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    if (text.includes('lcb') || text.includes('long-context-budget')) problems.push(text);
  }
});

await cdp.send('Page.navigate', { url: URL_TARGET });

let found = false;
for (let attempt = 0; attempt < 80; attempt += 1) {
  await sleep(250);
  const state = await cdp.evaluate(`(() => {
    const trigger = document.querySelector('.lcb-trigger');
    return {
      ready: document.readyState,
      trigger: trigger !== null,
      text: trigger ? trigger.textContent : null,
      disabled: trigger ? trigger.disabled : null,
      title: trigger ? trigger.getAttribute('title') : null,
      composer: document.querySelector('[class*="InputBar"][class*="row"]') !== null,
    };
  })()`);
  if (state.trigger) {
    found = true;
    console.log('trigger found:', JSON.stringify(state));
    break;
  }
  if (attempt === 0) console.log('waiting… initial:', JSON.stringify(state));
}

if (!found) {
  console.log('trigger NOT found');
  const dump = await cdp.evaluate(`(() => ({
    body: document.body.innerText.slice(0, 600),
    slots: [...document.querySelectorAll('[class*="trailing"] button')].map((b) => b.className + '|' + b.textContent),
  }))()`);
  console.log(JSON.stringify(dump, null, 2));
  await cdp.shot('00-missing.png');
} else {
  console.log('shot:', await cdp.shot('01-trigger.png'));
  await cdp.evaluate(`document.querySelector('.lcb-trigger').click()`);
  await sleep(400);
  const panel = await cdp.evaluate(`(() => {
    const panel = document.querySelector('.lcb-panel');
    if (!panel) return null;
    const rect = panel.getBoundingClientRect();
    return {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      title: panel.querySelector('.lcb-head-title')?.textContent,
      value: panel.querySelector('.lcb-head-value')?.textContent,
      usage: panel.querySelector('.lcb-usage')?.textContent,
      stops: panel.querySelectorAll('.lcb-stop').length,
      scale: panel.querySelector('.lcb-scale')?.textContent,
      stopValues: [...panel.querySelectorAll('.lcb-stop')].length,
      range: (() => { const r = panel.querySelector('.lcb-range'); return r ? { min: r.min, max: r.max, value: r.value, busy: r.dataset.busy } : null; })(),
    };
  })()`);
  console.log('panel:', JSON.stringify(panel));
  await cdp.shot('02-panel.png');
  console.log('problems:', JSON.stringify(problems));
}

await sleep(100);
chrome.kill();
process.exit(0);
