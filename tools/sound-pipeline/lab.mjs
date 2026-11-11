// Audio lab driver: local static server + headless Chrome (CDP) running lab.html.
// Usage:
//   node lab.mjs info  <list.txt>                 (one path per line, relative to scratchpad)
//   node lab.mjs sheet <out.png> <items.json> [cols] [maxDur]
//   node lab.mjs pcm   <items.json> <outDir>      items: [{name, path, t0?, t1?}] -> outDir/name.s16 (mono 44.1k)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Work dir with downloads (dl/), decoded PCM (pcm/) and QA renders (proc/). Override with TM_SOUND_WORK.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const S = (process.env.TM_SOUND_WORK || path.join(HERE, 'work')).split(path.sep).join('/');
const PORT = 8765, CDP = 9340;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (p) => `http://127.0.0.1:${PORT}/` + p.split('/').map(encodeURIComponent).join('/');

export async function openLab() {
  fs.mkdirSync(S, { recursive: true }); fs.copyFileSync(path.join(HERE, 'lab.html'), path.join(S, 'lab.html'));
  const srv = spawn('python', ['-I', '-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', S], { stdio: 'ignore' });
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${S}/.chrome-profile`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 60; i++) { try { list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); if (list.length) break; } catch {} await sleep(200); }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600)); return r.result.result.value; };
  for (let i = 0; i < 30; i++) { try { await fetch(url('lab.html')); break; } catch { await sleep(200); } }
  await send('Page.navigate', { url: url('lab.html') });
  await sleep(800);
  const close = () => { try { ws.close(); } catch {} chrome.kill(); srv.kill(); };
  return { send, ev, close, url };
}

async function main() {
  const [mode, a, b, c, d] = process.argv.slice(2);
  const L = await openLab();
  try {
    if (mode === 'info') {
      const files = fs.readFileSync(a, 'utf8').split(/\r?\n/).filter(Boolean);
      for (const f of files) {
        try { const r = await L.ev(`lab.info(${JSON.stringify(url(f))})`); console.log(`${r.dur.toFixed(2).padStart(7)}s ch${r.channels} pk ${r.peak.toFixed(2)} rms ${r.rms.toFixed(3)}  ${f}`); }
        catch (e) { console.log('ERR', f, String(e).slice(0, 120)); }
      }
    } else if (mode === 'sheet') {
      const items = JSON.parse(fs.readFileSync(b, 'utf8')).map((it) => (it.path ? Object.assign({}, it, { url: url(it.path) }) : it));
      const size = await L.ev(`lab.sheet(${JSON.stringify(items)}, { cols: ${+c || 4}, maxDur: ${+d || 0} })`);
      await L.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      const shot = await L.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } });
      fs.writeFileSync(a, Buffer.from(shot.result.data, 'base64'));
      console.log('sheet', a, size.w + 'x' + size.h);
    } else if (mode === 'pcm') {
      const items = JSON.parse(fs.readFileSync(a, 'utf8'));
      fs.mkdirSync(b, { recursive: true });
      for (const it of items) {
        const r = await L.ev(`lab.pcm(${JSON.stringify(url(it.path))}, ${it.t0 || 0}, ${it.t1 || 0})`);
        fs.writeFileSync(path.join(b, it.name + '.s16'), Buffer.from(r.b64, 'base64'));
      }
      console.log('pcm', items.length, 'files ->', b);
    }
  } finally { L.close(); }
}
if (process.argv[1] && process.argv[1].endsWith('lab.mjs')) main().catch((e) => { console.error(e); process.exit(1); });
