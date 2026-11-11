// Sound mix test: real battles rendered offline through the game's sound engine (OfflineAudioContext
// inside headless Chrome), then measured.   node tests/audio-mix.test.mjs [--wav <dir>]
// Checks numbers a human can't eyeball: clipping, clicks, loudness scaling with battle size and
// camera distance, voice budget, which sounds/beds actually fire. It cannot judge taste: listen
// with tools/sound-board.html or the WAV dumps (--wav) for that.
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, check, results } from './lib/cdp.mjs';

const wavDir = process.argv.includes('--wav') ? process.argv[process.argv.indexOf('--wav') + 1] : null;
const b = await openBrowser();
try {
  await b.open();
  await b.ev('TM.Game.frame = () => {}; true'); // stop the page loop: the test drives the engine itself
  const load = await b.ev(`TM.Audio.load().then(() => ({ pools: Object.keys(TM.Audio.pools).length, beds: Object.keys(TM.Audio.beds).length, crowds: Object.keys(TM.Audio.crowds).length, noCtx: TM.Audio.ctx === null }))`);
  check('sounds, beds and crowd variants ready', load.pools >= 20 && load.beds >= 9 && load.crowds >= 5, load);
  // Loops must be sample-exact (MP3 delay/padding removed) and have no click at the loop point:
  // the curvature across the seam must look like any other spot of the same loop.
  const loops = await b.ev(`(() => {
    const meta = Object.fromEntries(TM.SOUND_BANK.sounds.filter((s) => s[1] === 'bed').map((s) => [s[0].replace('bed_', ''), s[3]]));
    const out = {};
    for (const [k, m] of Object.entries(meta)) {
      const d = TM.Audio.beds[k].getChannelData(0), n = d.length;
      const sd = (i) => Math.abs(d[(i + 1) % n] - 2 * d[i] + d[(i - 1 + n) % n]);
      const all = []; for (let i = 1; i < n - 1; i += 5) all.push(sd(i)); all.sort((a, b) => a - b);
      let seam = 0; for (let i = -3; i <= 3; i++) seam = Math.max(seam, sd((i + n) % n));
      out[k] = { exact: n === m.samples, seam: +(seam / all[Math.floor(all.length * 0.999)]).toFixed(2) };
    }
    return out;
  })()`);
  check('loops are sample-exact (codec delay and padding removed)', Object.values(loops).every((l) => l.exact), loops);
  check('no click at any loop point', Object.values(loops).every((l) => l.seam < 1), loops);

  await b.ev(`window.__run = async function (cfg) {
    const sr = 44100, T = cfg.seconds, A = TM.Audio;
    const octx = new OfflineAudioContext(2, Math.ceil(sr * (T + 2)), sr);
    let vt = 0;
    A.voices = []; A.bedNodes = null; A.bags = {}; A.act = 0; A.actAcc = 0; A.gallop = 0; A.gallopAcc = 0; A.cue = [];
    A.cnt.fill(0); A.sx.fill(0); A.sy.fill(0); A.t0.fill(0); A.next.fill(0); A.pendingStart = null; A.drumT = 0; A.tokens = 14;
    A.stats = { started: 0, dropped: 0, stolen: 0, maxActive: 0, byType: {}, frameMs: 0, frames: 0 };
    A.muted = false; A.volume = 1; // worst case for clipping
    A.attach(octx, { clock: () => vt });
    A.setPhase('battle');
    const mk = (c) => ({ counts: Object.assign({ sword: 0, spear: 0, archer: 0, knight: 0, giant: 0 }, c), formation: 'line' });
    const B = new TM.Battle({ armies: [mk(cfg.red), mk(cfg.blue)], seed: 4242 }, TM.Game.fx);
    B.start();
    const cam = { x: cfg.cam[0], y: cfg.cam[1], zoom: cfg.cam[2] };
    A.lx = cam.x; A.ly = cam.y;
    A.battleStart(B);
    let frameMs = 0, peakVoices = 0; const bedMax = {};
    for (let f = 0; f < T * 60; f++) {
      const t = performance.now();
      A.frame(1 / 60, 1, cam, 1600, 900, B.state === 'running', B);
      frameMs += performance.now() - t;
      peakVoices = Math.max(peakVoices, A.voices.length);
      for (const [k, n] of Object.entries(A.bedNodes || {})) if (n) bedMax[k] = Math.max(bedMax[k] || 0, n.level);
      B.step(1 / 60); vt += 1 / 60;
    }
    const buf = await octx.startRendering(), L = buf.getChannelData(0), R = buf.getChannelData(1);
    const per = []; let peak = 0, clip = 0, nan = 0;
    for (let s = 0; s < T; s++) { let e = 0; for (let i = s * sr; i < (s + 1) * sr; i++) { const v = (L[i] + R[i]) / 2; e += v * v; } per.push(Math.sqrt(e / sr)); }
    for (let i = 0; i < L.length; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > peak) peak = a; if (a >= 0.999) clip++; if (a !== a) nan++; }
    let loudStep = 0, pv = 0; const W = 2205;
    for (let i = W; i < L.length; i += W) { let e = 0; for (let j = i - W; j < i; j++) e += L[j] * L[j]; const r = Math.sqrt(e / W); if (pv > 0.01 && r > 0.01) loudStep = Math.max(loudStep, Math.abs(20 * Math.log10(r / pv))); pv = r; }
    let edges = 0; for (const arr of Object.values(A.pools)) for (const x of arr) { const d = x.getChannelData(0); let m = 0; for (let i = 0; i < 24; i++) m = Math.max(m, Math.abs(d[i]), Math.abs(d[d.length - 1 - i])); if (m > 0.02) edges++; }
    window.__buf = buf;
    return { per, peak, clip, nan, loudStep, edges, started: A.stats.started, maxActive: Math.max(A.stats.maxActive, peakVoices), byType: A.stats.byType, frameMs: frameMs / (T * 60), beds: bedMax };
  }; true`);

  const SC = {
    skirmish: { seconds: 24, red: { sword: 6, spear: 4 }, blue: { sword: 6, spear: 4 }, cam: [1200, 750, 1.0] },
    battle: { seconds: 24, red: { sword: 70, spear: 50, archer: 50, knight: 14 }, blue: { sword: 70, spear: 50, archer: 50, knight: 14 }, cam: [1200, 750, 0.6] },
    massacre: { seconds: 24, red: { sword: 400, spear: 250, archer: 250, knight: 90, giant: 8 }, blue: { sword: 400, spear: 250, archer: 250, knight: 90, giant: 8 }, cam: [1200, 750, 0.4] },
    farCamera: { seconds: 24, red: { sword: 400, spear: 250, archer: 250, knight: 90, giant: 8 }, blue: { sword: 400, spear: 250, archer: 250, knight: 90, giant: 8 }, cam: [150, 150, 1.2] },
    giants: { seconds: 24, red: { giant: 8 }, blue: { sword: 225, archer: 60 }, cam: [1200, 750, 1.0] },
    cavalry: { seconds: 16, red: { knight: 90 }, blue: { spear: 160, archer: 40 }, cam: [1200, 750, 0.7] },
  };
  const R = {};
  const mean = (a, s, e) => a.slice(s, e).reduce((x, y) => x + y, 0) / (e - s);
  const dB = (v) => (20 * Math.log10(v + 1e-9)).toFixed(1);
  for (const [k, cfg] of Object.entries(SC)) {
    R[k] = await b.ev(`window.__run(${JSON.stringify(cfg)})`);
    console.log(`  ${k.padEnd(10)} level ${dB(mean(R[k].per, 10, cfg.seconds))} dBFS  peak ${dB(R[k].peak)} dBFS  voices ${(R[k].started / cfg.seconds).toFixed(0)}/s max ${R[k].maxActive}  engine ${R[k].frameMs.toFixed(3)} ms`);
    if (wavDir) {
      const n = await b.ev(`(() => { const x = window.__buf, L = x.getChannelData(0), Rr = x.getChannelData(1), out = new Int16Array(L.length * 2); for (let i = 0; i < L.length; i++) { out[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767; out[2 * i + 1] = Math.max(-1, Math.min(1, Rr[i])) * 32767; } const u8 = new Uint8Array(out.buffer); window.__b64 = []; for (let i = 0; i < u8.length; i += 600000) { let t = ''; const e = Math.min(u8.length, i + 600000); for (let j = i; j < e; j += 8192) t += String.fromCharCode.apply(null, u8.subarray(j, Math.min(e, j + 8192))); __b64.push(btoa(t)); } return __b64.length; })()`);
      const parts = []; for (let c = 0; c < n; c++) parts.push(Buffer.from(await b.ev(`__b64[${c}]`), 'base64'));
      const pcm = Buffer.concat(parts), h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(44100, 24); h.writeUInt32LE(176400, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
      fs.mkdirSync(wavDir, { recursive: true });
      fs.writeFileSync(path.join(wavDir, `battle_${k}.wav`), Buffer.concat([h, pcm]));
    }
  }
  const all = Object.values(R);
  check('no clipping or NaN at 100% volume', all.every((r) => r.clip === 0 && r.nan === 0 && r.peak < 1), all.map((r) => r.peak.toFixed(3)));
  check('no clicks at the edges of any recording', all[0].edges === 0, all[0].edges);
  check('no sudden level jumps inside loud passages (< 18 dB / 50 ms)', all.every((r) => r.loudStep < 18), all.map((r) => r.loudStep.toFixed(1)));
  check('voice cap (36) respected', all.every((r) => r.maxActive <= 36), all.map((r) => r.maxActive));
  check('bigger battles sound bigger: skirmish < battle < massacre', mean(R.skirmish.per, 10, 24) < mean(R.battle.per, 10, 24) && mean(R.battle.per, 10, 24) < mean(R.massacre.per, 10, 24));
  check('massacre ≥ 4 dB louder than a skirmish', 20 * Math.log10(mean(R.massacre.per, 10, 24) / mean(R.skirmish.per, 10, 24)) >= 4);
  check('fight far from the camera is much quieter (< 55%)', mean(R.farCamera.per, 10, 24) < 0.55 * mean(R.massacre.per, 10, 24));
  check('melee: blades, shields and body blows all heard', ['clash', 'flesh', 'shield'].every((k) => (R.battle.byType[k] || 0) > 5), R.battle.byType);
  check('archery: bows, volleys whistling, arrow impacts', (R.battle.byType.bow || 0) > 5 && (R.battle.byType.arrowFly || 0) > 5 && (R.battle.byType.arrowhit || 0) > 5);
  check('giants: club smashes and footsteps', (R.giants.byType.giant || 0) > 5 && (R.giants.byType.stomp || 0) > 5, R.giants.byType);
  check('cavalry: charge impacts and braced spears', (R.cavalry.byType.charge || 0) + (R.cavalry.byType.brace || 0) > 3);
  check('start cue: two horns and war cries', all.every((r) => r.byType.horn === 2 && r.byType.warcry >= 4));
  check('beds follow the battle: march + drums before contact, roar + din in the melee', R.battle.beds.march > 0.1 && R.battle.beds.drums > 0.1 && R.massacre.beds.roarA > 0.2 && R.massacre.beds.din > 0.2, R.massacre.beds);
  check('cavalry bed follows galloping knights', R.cavalry.beds.gallop > 0.2);
  check('panic bed when an army routs', Math.max(R.massacre.beds.panic, R.giants.beds.panic) > 0.1);
  check('voice rate bounded in the massacre (< 120 / s)', R.massacre.started / 24 < 120, R.massacre.started / 24);
  check('engine cost < 0.4 ms per frame in the massacre', R.massacre.frameMs < 0.4, R.massacre.frameMs);
} catch (e) {
  check('test run finished without crashing', false, e.message);
} finally {
  check('no JavaScript errors in the page', b.errors.length === 0, b.errors.slice(0, 5));
  b.close();
}
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exitCode = results.failed ? 1 : 0;
