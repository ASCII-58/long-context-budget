/**
 * 用无头 Chrome 载入 client.js 的**真身**（同一份文件），在一个最小的
 * 宿主桩上跑一遍：只关心「模块能否注册、组件能否渲染出 DOM」，
 * 不碰真实会话。这样能在不登录 GUI 的情况下把渲染期的崩溃抓出来。
 *
 * 用法：node scripts/probe-client.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ROOT = join(import.meta.dirname, '..');
const PORT = 9344;

const clientSource = readFileSync(join(ROOT, 'client.js'), 'utf8');

/** 极简 React 桩：够 client.js 注册与首次渲染跑通。 */
const STUB = `
<!doctype html>
<meta charset="utf-8">
<div id="root"></div>
<script>
window.__errors = [];
window.addEventListener('error', (event) => window.__errors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__errors.push('reject:' + String(event.reason)));

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat() };
}
function renderTree(node, out) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
  if (Array.isArray(node)) { for (const child of node) renderTree(child, out); return; }
  if (node.type === 'style') { out.push('<' + (node.props && node.props.children) + '>'); return; }
  const props = node.props || {};
  out.push('<' + node.type + ' class="' + (props.className || '') + '">');
  renderTree(node.children, out);
  out.push('</' + node.type + '>');
}

const hooks = { states: [], index: 0 };
function useState(initial) {
  const slot = hooks.index++;
  if (hooks.states.length <= slot) hooks.states[slot] = typeof initial === 'function' ? initial() : initial;
  return [hooks.states[slot], (value) => { hooks.states[slot] = value; }];
}
function useEffect() {}
function useLayoutEffect() {}
function useRef(initial) { return { current: initial }; }
function useMemo(factory) { return factory(); }
function useCallback(fn) { return fn; }
function useId() { return 'probe'; }
function useSyncExternalStore(subscribe, getSnapshot) { return getSnapshot(); }
function createContext(value) { return { Provider: 'Provider', value }; }
function useContext(ctx) { return ctx && ctx.value; }

const React = {
  createElement, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback,
  useId, useSyncExternalStore, createContext, useContext, memo: (fn) => fn,
};

const registered = [];
window.__ModuleLoader__ = {
  load(definition) {
    window.__definition = definition;
    const factory = definition.factory((name) => {
      if (name === 'react') return React;
      if (name === 'react-dom') throw new Error('react-dom unavailable');
      throw new Error('unexpected require: ' + name);
    });
    const slots = {
      inject(key, callback) {
        window.__injected = { key };
        /* 宿主会在槽位声明就绪时调用回调；桩里立刻调用。 */
        callback();
      },
      register(options, component) { registered.push({ options, component }); },
    };
    const ctx = {
      slots,
      get(name) {
        if (name === 'locale') {
          return { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} };
        }
        if (name === 'slots') return slots;
        return undefined;
      },
    };
    factory.apply(ctx);
    window.__registered = registered;
  },
};
</script>
<script>
${clientSource.replace(/<\/script>/g, '<\\/script>')}
</script>
<script>
window.__report = (() => {
  const registered = window.__registered || [];
  const entry = registered.find((item) => item.options && item.options.id === 'long-context-budget');
  const report = { registeredCount: registered.length, found: !!entry };
  if (entry) {
    report.options = entry.options;
    const Component = entry.component;
    const props = {
      sessionId: 'session-probe',
      useProjection: (key) => (key === 'contextPressure'
        ? { projectedTokens: 120000, contextWindow: 1000000 }
        : undefined),
    };
    const out = [];
    try {
      renderTree(Component(props), out);
      report.html = out.join('');
      report.rendered = true;
    } catch (error) {
      report.rendered = false;
      report.error = String(error && error.stack ? error.stack : error);
    }
  }
  report.errors = window.__errors;
  return report;
})();
</script>
`;

const dir = mkdtempSync(join(tmpdir(), 'lcb-probe-'));
const pagePath = join(dir, 'probe.html');
writeFileSync(pagePath, STUB);

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
    '--allow-file-access-from-files',
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

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
let seq = 0;
const waiting = new Map();
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: 'file:///' + pagePath.replace(/\\/g, '/') });
await sleep(1200);

const result = await send('Runtime.evaluate', {
  expression: 'JSON.stringify(window.__report || { missing: true, errors: window.__errors })',
  returnByValue: true,
});
const report = JSON.parse(result.result.value);
console.log(JSON.stringify(report, null, 2));

chrome.kill();
process.exit(report.found && report.rendered && !report.error ? 0 : 1);
