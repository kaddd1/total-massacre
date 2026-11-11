// Sound asset pipeline: raw PCM (mono 44.1 kHz, from lab.mjs) -> sliced, cleaned,
// loudness-normalised, encoded MP3 files in the project + manifest.
// Usage: node process.mjs <projectDir> [--qa]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lamejs from '@breezystack/lamejs';

// Work dir with downloads (dl/), decoded PCM (pcm/) and QA renders (proc/). Override with TM_SOUND_WORK.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const S = (process.env.TM_SOUND_WORK || path.join(HERE, 'work')).split(path.sep).join('/');
const SR = 44100;
const PROJECT = process.argv[2];
const QA = process.argv.includes('--qa');
const OUT = path.join(PROJECT, 'assets', 'sounds');

// ------------------------------------------------------------------ DSP
class Biquad {
  constructor(type, f, q, gainDb) {
    const w = 2 * Math.PI * f / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * (q || 0.7071));
    const A = Math.pow(10, (gainDb || 0) / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + a; a1 = -2 * c; a2 = 1 - a; }
    else if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + a; a1 = -2 * c; a2 = 1 - a; }
    else if (type === 'hs') {
      const sq = 2 * Math.sqrt(A) * a;
      b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
      a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq;
    } else if (type === 'ls') {
      const sq = 2 * Math.sqrt(A) * a;
      b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq);
      a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; this.z1 = 0; this.z2 = 0;
  }
  run(x) { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { const v = x[i], o = this.b0 * v + this.z1; this.z1 = this.b1 * v - this.a1 * o + this.z2; this.z2 = this.b2 * v - this.a2 * o; y[i] = o; } return y; }
}
const filt = (x, type, f, q, g) => new Biquad(type, f, q, g).run(x);
const db = (v) => 20 * Math.log10(v + 1e-12);
function peak(x) { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; }
function kweight(x) { return filt(filt(x, 'hs', 1500, 0.7071, 4), 'hp', 38, 0.5); }
// max K-weighted RMS over a sliding window (dB)
function loudMax(x, winSec) {
  const k = kweight(x), w = Math.max(1, Math.round(winSec * SR)), hop = Math.max(1, w >> 2);
  let best = -200;
  if (k.length <= w) { let e = 0; for (const v of k) e += v * v; return db(Math.sqrt(e / Math.max(1, k.length))); }
  for (let s = 0; s + w <= k.length; s += hop) { let e = 0; for (let i = s; i < s + w; i++) e += k[i] * k[i]; best = Math.max(best, db(Math.sqrt(e / w))); }
  return best;
}
function loudAvg(x) { const k = kweight(x); let e = 0; for (const v of k) e += v * v; return db(Math.sqrt(e / k.length)); }
function gain(x, g) { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] * g; return y; }
function fadeIn(x, sec) { const n = Math.min(x.length, Math.round(sec * SR)); for (let i = 0; i < n; i++) x[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / n); return x; }
function fadeOut(x, sec) { const n = Math.min(x.length, Math.round(sec * SR)); for (let i = 0; i < n; i++) x[x.length - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / n); return x; }
// RMS envelope in dB, hop 5 ms, window 10 ms
function env(x) {
  const hop = 220, w = 441, n = Math.floor(x.length / hop), e = new Float32Array(n);
  for (let f = 0; f < n; f++) { let s = 0, c = 0; for (let i = f * hop; i < Math.min(x.length, f * hop + w); i++) { s += x[i] * x[i]; c++; } e[f] = db(Math.sqrt(s / Math.max(1, c))); }
  return e;
}
function percentile(a, p) { const s = Array.from(a).sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; }
// Split a multi-take recording into events.
function slice(x, o) {
  const e = env(x), hop = 220;
  const pk = Math.max(...e), noise = percentile(e, 0.1);
  const thr = Math.max(pk - (o.range || 32), noise + (o.snr || 12));
  const minGap = Math.round((o.minGap || 0.06) / 0.005);
  let regs = [], cur = null;
  for (let f = 0; f < e.length; f++) {
    if (e[f] > thr) { if (cur && f - cur.end <= minGap) cur.end = f; else { cur = { start: f, end: f }; regs.push(cur); } }
  }
  const out = [];
  for (let r = 0; r < regs.length; r++) {
    const g = regs[r];
    let rp = -200; for (let f = g.start; f <= g.end; f++) rp = Math.max(rp, e[f]);
    let a = g.start; while (a > 0 && g.start - a < 8 && e[a - 1] > thr - 18) a--;
    const nextStart = r + 1 < regs.length ? regs[r + 1].start - 2 : e.length - 1;
    let b = g.end; while (b < nextStart && e[b + 1] > rp - (o.tail || 42)) b++;
    const t0 = Math.max(0, a * hop - 0.004 * SR), t1 = Math.min(x.length, (b + 2) * hop);
    out.push({ a: Math.round(t0), b: Math.round(t1), peakDb: rp, dur: (t1 - t0) / SR });
  }
  return out.filter((s) => s.peakDb > pk - (o.within || 14) && s.dur >= (o.minLen || 0.05) && s.dur <= (o.maxRaw || 99));
}
function pickEven(list, n) { if (list.length <= n) return list; const r = []; for (let i = 0; i < n; i++) r.push(list[Math.round(i * (list.length - 1) / Math.max(1, n - 1))]); return [...new Set(r)]; }
function loopify(x, xf) {
  const n = Math.round(xf * SR), len = x.length - n, y = new Float32Array(len);
  for (let i = 0; i < len; i++) y[i] = x[i];
  for (let i = 0; i < n; i++) { const t = i / n, a = Math.sin(t * Math.PI / 2), b = Math.cos(t * Math.PI / 2); y[i] = x[i] * a + x[len + i] * b; }
  return y;
}

// ------------------------------------------------------------------ I/O
function readPcm(id) {
  const b = fs.readFileSync(path.join(S, 'pcm', id + '.s16'));
  const i16 = new Int16Array(b.buffer, b.byteOffset, b.length >> 1), f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  return f;
}
function toI16(x) { const o = new Int16Array(x.length); for (let i = 0; i < x.length; i++) { const v = Math.max(-1, Math.min(1, x[i])); o[i] = v < 0 ? v * 32768 : v * 32767; } return o; }
function encodeMp3(x, kbps) {
  const enc = new lamejs.Mp3Encoder(1, SR, kbps), pcm = toI16(x), parts = [];
  for (let i = 0; i < pcm.length; i += 1152) { const b = enc.encodeBuffer(pcm.subarray(i, i + 1152)); if (b.length) parts.push(Buffer.from(b)); }
  const f = enc.flush(); if (f.length) parts.push(Buffer.from(f));
  return Buffer.concat(parts);
}
function wav(x) {
  const d = Buffer.from(toI16(x).buffer), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(d.length, 40);
  return Buffer.concat([h, d]);
}

// ------------------------------------------------------------------ recipes
// type: 'slices' (multi-take file), 'whole' (single take), 'range' (t0..t1), 'bed' (looped range)
// hp: high-pass Hz, lp: optional low-pass, max: max length (s), n: takes to keep, target: loudness dB
const MS = (n) => 'ms_' + n.replace(/ /g, '_');
const R = [];
const add = (cat, src, opt) => R.push(Object.assign({ cat, src }, opt));
// --- melee: blade on blade (studio recordings by MedicineStorm)
for (const n of ['Norse Sword Katana Blade on Blade', 'Sabre Norse Sword Blade on Blade', 'Sabre Katana Blade on Blade', 'Seax Norse Sword Blade on Blade', 'Spear Norse Sword Blade on Blade', 'Dagger Norse Sword Blade on Blade', 'Seax Katana Blade on Blade', 'Spear Katana Blade on Blade', 'Sabre Norse Sword Hilt on Blade'])
  add('clash', MS(n), { type: 'slices', n: 2, hp: 140, max: 0.75, target: -13, tailFade: 0.45, sl: { minGap: 0.05, tail: 56 } });
for (const n of ['Axe Norse Sword Blade on Blade', 'Axe Katana Blade on Blade', 'Mace Norse Sword Blade', 'Mace Katana Blade', 'Mace Axe Blade and Haft'])
  add('clashHeavy', MS(n), { type: 'slices', n: 2, hp: 90, max: 0.9, target: -12, tailFade: 0.45, sl: { minGap: 0.05, tail: 56 } });
for (const n of ['Spear Katana Haft on Blade', 'Axe Spear Haft on Haft', 'Mace Spear Haft', 'Axe Sabre Haft on Hilt'])
  add('wood', MS(n), { type: 'slices', n: 2, hp: 90, max: 0.6, target: -13, sl: { minGap: 0.05, tail: 38 } });
for (const i of [0, 1, 2, 3, 4]) add('wood', 'k_impactWood_heavy_00' + i, { type: 'whole', hp: 70, max: 0.5, target: -13, skip: i > 2 });
for (const i of [0, 2]) add('wood', 'k_impactPlank_medium_00' + i, { type: 'whole', hp: 70, max: 0.7, target: -14 });
// --- body blows
for (const i of [0, 1, 2, 3, 4]) add('hit', 'k_impactPunch_heavy_00' + i, { type: 'whole', hp: 45, max: 0.6, target: -12 });
for (const i of [0, 2, 4]) add('hit', 'k_impactPunch_medium_00' + i, { type: 'whole', hp: 60, max: 0.5, target: -12 });
for (const i of ['01', '03', '06', '08', '10', '12']) add('hitHeavy', 'in_hit' + i + '_mp3', { type: 'whole', hp: 35, max: 0.9, target: -11 });
add('slash', 'kr_knifeSlice', { type: 'whole', hp: 300, max: 0.4, target: -16 });
add('slash', 'kr_knifeSlice2', { type: 'whole', hp: 300, max: 0.4, target: -16 });
add('slash', 'kr_chop', { type: 'whole', hp: 120, max: 0.4, target: -15 });
add('slash', 'mx_sword_sound', { type: 'whole', hp: 120, max: 0.5, target: -14 });
for (const i of [0, 1, 2]) add('armor', 'k_impactPlate_heavy_00' + i, { type: 'whole', hp: 70, max: 0.6, target: -13 });
for (const i of [0, 2]) add('armor', 'k_impactPlate_medium_00' + i, { type: 'whole', hp: 90, max: 0.5, target: -14 });
// --- archery
add('bow', 'mt_English_Longbow_Shoot', { type: 'slices', n: 4, hp: 90, max: 0.75, target: -15, sl: { minGap: 0.08, tail: 40 } });
add('bow', 'mt_Scythian_Recurve_Shoot', { type: 'slices', n: 4, hp: 90, max: 0.75, target: -15, sl: { minGap: 0.08, tail: 40 } });
add('bow', 'bt_Bow', { type: 'whole', hp: 90, max: 0.6, target: -15 });
add('arrowFly', 'mt_Scythian_Recurve_Arrow_Pass', { type: 'slices', n: 3, hp: 150, max: 0.9, target: -16, sl: { minGap: 0.12, tail: 35 } });
add('arrowFly', 'mt_Scythian_Recurve_Heavy_Arrow_Passby', { type: 'slices', n: 3, hp: 150, max: 0.9, target: -16, sl: { minGap: 0.12, tail: 35 } });
add('arrowHit', 'fs205938', { type: 'whole', hp: 80, max: 0.5, target: -13 });
add('arrowHit', 'fs521552', { type: 'whole', hp: 80, max: 0.3, target: -13 });
for (const i of [0, 1, 2]) add('arrowHit', 'k_impactSoft_medium_00' + i, { type: 'whole', hp: 80, max: 0.4, target: -14 });
for (const i of [0, 1, 2, 3]) add('arrowGround', 'k_footstep_grass_00' + i, { type: 'whole', hp: 120, max: 0.3, target: -16 });
// --- falls / heavy thuds
add('fall', 'fs504626', { type: 'whole', hp: 35, max: 1.3, target: -12 });
add('fall', 'fs417994', { type: 'whole', hp: 30, max: 1.3, target: -12 });
add('fall', 'fs187136', { type: 'whole', hp: 35, max: 0.9, target: -12 });
for (const i of [0, 1, 2]) add('thud', 'k_impactSoft_heavy_00' + i, { type: 'whole', hp: 28, max: 0.6, target: -12 });
// --- voices
add('pain', 'fs610998', { type: 'slices', n: 6, hp: 110, max: 0.7, kbps: 64, target: -15, sl: { minGap: 0.12, tail: 38, range: 34 } });
add('pain', 'fs442288', { type: 'slices', n: 6, hp: 110, max: 0.7, kbps: 64, target: -15, sl: { minGap: 0.08, tail: 38, range: 34 } });
for (const i of [1, 2, 3, 4, 5, 6]) add('pain', 'hy_3grunt' + i, { type: 'whole', hp: 110, max: 0.8, target: -15, kbps: 64 });
add('death', 'dpg', { type: 'slices', n: 12, hp: 100, max: 1.3, kbps: 64, target: -14, sl: { minGap: 0.14, tail: 40, range: 34, within: 16 } });
add('death', 'fs166943', { type: 'slices', n: 2, hp: 100, max: 1.4, kbps: 64, target: -14, sl: { minGap: 0.18, tail: 40, within: 18 } });
add('death', 'fs131710', { type: 'slices', n: 4, hp: 100, max: 1.3, kbps: 64, target: -14, sl: { minGap: 0.25, tail: 40, within: 18 } });
add('death', 'tw_die1', { type: 'whole', hp: 100, max: 1.0, target: -14, kbps: 64 });
add('scream', 'fs556976', { type: 'slices', n: 5, hp: 110, max: 1.7, kbps: 64, target: -14, sl: { minGap: 0.2, tail: 40, within: 18 } });
for (const k of ['1yell1', '1yell4', '2yell1', '2yell9', '3yell2', '3yell6', '3yell10', 'yell5'])
  add('warcry', 'hy_' + k, { type: 'whole', hp: 120, max: 1.6, target: -15, kbps: 64 });
// --- horses
add('neigh', 'fs269571', { type: 'whole', hp: 150, max: 1.5, target: -14, kbps: 64 });
add('neigh', 'fs521246', { type: 'whole', hp: 150, max: 1.9, target: -14, kbps: 64 });
// --- giants
for (const k of ['giant1', 'giant2', 'giant3', 'giant4', 'giant5', 'ogre1', 'ogre3', 'ogre5']) add('giantGrunt', 'rpg_' + k, { type: 'whole', hp: 50, max: 0.9, target: -13, kbps: 64 });
add('giantRoar', 'troll', { type: 'slices', n: 4, hp: 40, max: 1.8, target: -12, kbps: 64, sl: { minGap: 0.25, tail: 40, within: 12 } });
add('giantRoar', 'mroar', { type: 'range', t0: 0, t1: 3.0, hp: 30, target: -12, fadeOut: 1.0, kbps: 64 });
// --- signals and one-shot crowd events
add('horn', 'fs539956', { type: 'whole', hp: 60, max: 4.4, target: -14, fadeOut: 0.6, kbps: 64 });
add('horn', 'fs512490', { type: 'range', t0: 0, t1: 7.0, hp: 60, target: -14, fadeOut: 2.2, kbps: 64 });
add('cheer', 'fs130568', { type: 'range', t0: 2.0, t1: 10.0, hp: 70, target: -16, fadeIn: 0.25, fadeOut: 2.5, kbps: 64 });
// --- loop beds (looped at runtime, levels follow the battle)
add('bed', 'wind1', { type: 'bed', name: 'wind', t0: 4, t1: 18, hp: 40, target: -24, kbps: 80 });
add('bed', 'fs480434', { type: 'bed', name: 'march', t0: 2, t1: 14.5, hp: 50, target: -20, kbps: 80 });
add('bed', 'fs175356', { type: 'bed', name: 'gallop', t0: 0, t1: 5.75, hp: 45, target: -18, kbps: 80, xf: 0.4 });
add('bed', 'fs547967', { type: 'bed', name: 'herd', t0: 4, t1: 15, hp: 45, target: -18, kbps: 80 });
add('bed', 'fs395583', { type: 'bed', name: 'roarA', t0: 3, t1: 17, hp: 80, target: -19, kbps: 80 });
add('bed', 'fs480775', { type: 'bed', name: 'roarB', t0: 4, t1: 21.5, // loop length differs from roarA so their sum doesn't repeat every few seconds
  hp: 80, target: -19, kbps: 80 });
add('bed', 'fs491405', { type: 'bed', name: 'panic', t0: 1, t1: 13, hp: 100, target: -19, kbps: 80 });
add('bed', 'hdrums', { type: 'bed', name: 'drums', t0: 0, t1: 14.7, hp: 30, target: -18, kbps: 80, xf: 0.25 });

// ------------------------------------------------------------------ run
const manifest = [];
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
if (QA) fs.mkdirSync(path.join(S, 'proc'), { recursive: true });
const qa = [];
let totalBytes = 0, totalSec = 0;
const counter = {};
for (const r of R) {
  if (r.skip) continue;
  const x = readPcm(r.src);
  let parts = [];
  if (r.type === 'slices') {
    const sl = slice(x, r.sl || {});
    parts = pickEven(sl, r.n).map((s) => x.slice(s.a, s.b));
    if (!parts.length) { console.log('NO SLICES', r.src); continue; }
  } else if (r.type === 'whole') {
    // trim leading/trailing silence of a single take
    const sl = slice(x, { range: 50, minGap: 10, tail: 50, within: 99 });
    parts = [sl.length ? x.slice(sl[0].a, sl[sl.length - 1].b) : x];
  } else {
    parts = [x.slice(Math.round(r.t0 * SR), Math.min(x.length, Math.round(r.t1 * SR)))];
  }
  for (let p of parts) {
    // clean-up chain
    const pre = Math.round(0.03 * SR), padded = new Float32Array(pre + p.length);
    for (let i = 0; i < pre; i++) padded[i] = p[0] * (i / pre); // ramp-in avoids a filter thump
    padded.set(p, pre);
    let y = filt(filt(padded, 'hp', r.hp || 40, 0.7071), 'hp', r.hp || 40, 0.7071).subarray(pre);
    if (r.lp) y = filt(y, 'lp', r.lp, 0.7071);
    y = Float32Array.from(y);
    if (r.max && y.length > r.max * SR) y = y.slice(0, Math.round(r.max * SR));
    let name;
    if (r.type === 'bed') {
      y = loopify(y, r.xf || 1.2);
      name = r.name;
    } else {
      fadeIn(y, r.fadeIn || 0.002);
      fadeOut(y, r.fadeOut || (r.tailFade ? y.length / SR * r.tailFade : Math.min(0.08, y.length / SR * 0.3)));
      counter[r.cat] = (counter[r.cat] || 0) + 1;
      name = `${r.cat}_${String(counter[r.cat]).padStart(2, '0')}`;
    }
    // loudness normalisation with a -1 dBFS peak ceiling
    const L = r.type === 'bed' ? loudAvg(y) : loudMax(y, 0.1);
    let g = Math.pow(10, (r.target - L) / 20);
    const pk = peak(y) * g;
    if (pk > 0.89) g *= 0.89 / pk;
    y = gain(y, g);
    const kbps = r.kbps || 80;
    let enc = y;
    if (r.type === 'bed') {
      // wrap padding: encode [loop tail | loop | loop head] so the codec's edge artefacts fall
      // outside the loop; the game cuts the exact loop back out (js/audio.js loopExact)
      const K = 4096;
      enc = new Float32Array(y.length + 2 * K);
      enc.set(y.subarray(y.length - K), 0); enc.set(y, K); enc.set(y.subarray(0, K), K + y.length);
    }
    const mp3 = encodeMp3(enc, kbps);
    const file = (r.type === 'bed' ? 'bed_' : '') + name + '.mp3';
    fs.writeFileSync(path.join(OUT, file), mp3);
    totalBytes += mp3.length; totalSec += y.length / SR;
    const entry = { id: r.type === 'bed' ? 'bed_' + name : name, cat: r.cat, file, src: r.src, dur: +(y.length / SR).toFixed(3), loud: +(r.type === 'bed' ? loudAvg(y) : loudMax(y, 0.1)).toFixed(1), peak: +db(peak(y)).toFixed(1), kbps, bytes: mp3.length };
    // loops must be sample-exact: MP3 adds codec delay/padding, so the game re-aligns the decoded audio
    // to the original start (fingerprint of the first samples) and cuts exactly `samples` samples
    if (r.type === 'bed') { entry.samples = y.length; entry.head = Array.from(y.subarray(0, 512), (v) => Math.round(v * 20000)); }
    manifest.push(entry);
    if (QA) { const w = path.join(S, 'proc', (r.type === 'bed' ? 'bed_' : '') + name + '.wav'); fs.writeFileSync(w, wav(y)); qa.push({ label: name + ' <' + r.src.slice(0, 24), path: 'proc/' + path.basename(w) }); }
  }
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
if (QA) fs.writeFileSync(path.join(S, 'qa.json'), JSON.stringify(qa));
const byCat = {};
for (const m of manifest) { const c = byCat[m.cat] || (byCat[m.cat] = { n: 0, sec: 0, kb: 0 }); c.n++; c.sec += m.dur; c.kb += m.bytes / 1024; }
for (const [c, v] of Object.entries(byCat)) console.log(c.padEnd(12), String(v.n).padStart(3), 'files', v.sec.toFixed(1).padStart(6) + 's', v.kb.toFixed(0).padStart(5) + ' KB');
console.log(`TOTAL ${manifest.length} files, ${totalSec.toFixed(1)} s, ${(totalBytes / 1024).toFixed(0)} KB`);

// ------------------------------------------------------------------ credits
const sources = JSON.parse(fs.readFileSync(path.join(HERE, 'sources.json'), 'utf8'));
const oga = JSON.parse(fs.readFileSync(path.join(HERE, 'oga_meta.json'), 'utf8'));
const fsm = JSON.parse(fs.readFileSync(path.join(HERE, 'fs_meta.json'), 'utf8'));
const OGA_OF = { ms_: 'medieval-sound-effects-weapon-impacts', mt_: 'medieval-sound-effects-weapon-textures', in_: '37-hitspunches', mx_: '3-melee-sounds', bt_: 'battle-sound-effects', hy_: 'male-gruntyelling-sounds', tw_: '5-hit-sounds-dying', rpg_: 'rpg-sound-pack', dpg: 'grunts-male-death-and-pain', troll: 'big-scary-troll-sounds', mroar: 'cc0-deep-monster-roar', hdrums: 'horde-war-drums-loop', wind: 'wind1' };
function credit(src) {
  if (src.startsWith('fs')) { const m = fsm[src.slice(2)]; return { pack: `Freesound #${src.slice(2)} "${m.title.replace(/ by [^ ]+$/, '')}"`, author: m.user, url: m.page, license: 'CC0 1.0' }; }
  if (src.startsWith('k_')) return { pack: 'Kenney "Impact Sounds"', author: 'Kenney (kenney.nl)', url: 'https://kenney.nl/assets/impact-sounds', license: 'CC0 1.0' };
  if (src.startsWith('kr_')) return { pack: 'Kenney "RPG Audio"', author: 'Kenney (kenney.nl)', url: 'https://kenney.nl/assets/rpg-audio', license: 'CC0 1.0' };
  const key = Object.keys(OGA_OF).find((k) => src.startsWith(k));
  const slug = OGA_OF[key], m = oga[slug];
  return { pack: `OpenGameArt "${slug}"`, author: (m.author || ['?'])[0], url: 'https://opengameart.org/content/' + slug, license: 'CC0 1.0' + (m.license.length > 1 ? ' (на выбор автора: ' + m.license.join(', ') + ')' : '') };
}
const packs = new Map();
for (const m of manifest) {
  const c = credit(m.src); m.credit = c.url;
  if (!packs.has(c.url)) packs.set(c.url, Object.assign({ files: [] }, c));
  packs.get(c.url).files.push(m.file);
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
let md = '# Звуки TOTAL MASSACRE: источники и лицензии\n\n' +
  'Все звуки взяты из открытых библиотек под лицензией **CC0 1.0 (общественное достояние)**. Атрибуция не требуется, но авторы указаны из уважения к их работе.\n\n' +
  'Обработка: нарезка дублей из многодублевых записей, фильтрация, фейды, выравнивание громкости, моно 44.1 кГц, MP3. ' +
  'Скрипт конвейера: `tools/sound-pipeline/process.mjs`. В игру файлы попадают через `node tools/build-sound-bundle.mjs` (собирает `js/sound-data.js`).\n\n' +
  '| Источник | Автор | Лицензия | Файлы в игре |\n|---|---|---|---|\n';
for (const p of packs.values()) md += `| [${p.pack}](${p.url}) | ${p.author} | ${p.license} | ${p.files.map((f) => f.replace('.mp3', '')).join(', ')} |\n`;
fs.writeFileSync(path.join(OUT, 'CREDITS.md'), md);
console.log('credits:', packs.size, 'sources');
