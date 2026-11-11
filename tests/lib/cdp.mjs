// Shared helpers for browser tests: find Chrome, open a page over the DevTools protocol, checks.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PAGE = pathToFileURL(path.join(ROOT, 'index.html')).href;
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => fs.existsSync(p));
if (!CHROME) { console.error('Chrome/Edge not found: set CHROME_PATH'); process.exit(2); }

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const results = { passed: 0, failed: 0 };
export const check = (name, cond, detail) => {
  if (cond) { results.passed++; console.log('PASS ' + name); } else { results.failed++; console.log('FAIL ' + name + (detail !== undefined ? '  — ' + JSON.stringify(detail) : '')); }
};

export async function openBrowser() {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-test-'));
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1600,900', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 100; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (list.length) break; } catch { /* starting */ } await sleep(150); }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map(), errors = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('console.error ' + JSON.stringify(msg.params.args.map((a) => a.value ?? a.description)));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(expr.slice(0, 120) + ' => ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result.result.value;
  };
  const key = async (code, k) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k }); await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k }); await sleep(120); };
  const mouse = (type, x, y, extra) => send('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', clickCount: 1 }, extra));
  const click = async (x, y, button) => { await mouse('mouseMoved', x, y); await mouse('mousePressed', x, y, { button: button || 'left' }); await mouse('mouseReleased', x, y, { button: button || 'left' }); await sleep(150); };
  const rect = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const scr = (x, y) => ev(`(() => { const c = TM.Game.cam, R = TM.Game.renderer, z = c.view(); return { x: (${x} - c.x) * z + R.vw / 2, y: (${y} - c.y) * z + R.vh / 2 }; })()`);
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  const open = async (query) => { await send('Page.navigate', { url: PAGE + (query || '') }); await sleep(1800); };
  const close = () => { try { ws.close(); } catch { /* ignore */ } proc.kill(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ } }, 500); };
  return { send, ev, key, mouse, click, rect, scr, open, close, errors };
}

