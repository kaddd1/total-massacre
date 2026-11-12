// Battle sound engine (Web Audio) built on real recorded sounds.
//
// Sounds: assets/sounds/*.mp3 (CC0, see assets/sounds/CREDITS.md), bundled as base64 in
// js/sound-data.js so the game still runs from file:// and offline.
//
// Flow:
//   Battle.snd()/hitSound() -> Audio.emit(event, x, y)   cheap per-(event, 200x200 cell) counters
//   Audio.frame()           -> every frame turns counters into a few voices:
//     * aggregation: one cell flushes at most once per `win` seconds; the event count picks a single
//       recording or a pre-mixed "crowd" variant (several real takes layered), so 100 duelling pairs
//       sound like one dense melee instead of 100 identical samples
//     * layering: an event is a recipe of layers (e.g. death = scream + body falling 0.4 s later)
//     * variation: shuffle-bag per pool (no immediate repeats), random pitch and gain per voice
//     * priorities + voice budget with stealing: giants/charges/deaths win over arrow patter
//     * distance: gain, low-pass, stereo pan and reverb send depend on the camera
//   Beds (seamless loops) follow the battle state: wind, marching feet, war drums before contact,
//   hooves of galloping cavalry, crowd roar + melee din (intensity), panicked crowd (routing units).
// Autoplay: decoding starts at load (OfflineAudioContext needs no gesture); the real AudioContext
// is created/resumed on the first user gesture. Randomness: Math.random only (never the seeded
// simulation RNG), so sound can't change a battle's outcome.
(function (TM) {
  'use strict';
  const C = TM.CONFIG;
  const STORE = 'total-massacre-audio-v1';
  const SR = 44100;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ------------------------------------------------------------------ event recipes
  // vol: event loudness · prio: importance 1..10 · win: min seconds between flushes of one cell
  // act: weight in the melee "intensity" that drives roar/din beds
  // layers: pool, gain, rate [lo,hi], delay [lo,hi] s, chance · crowd: pool with pre-mixed m/l variants
  const EVENTS = {
    clash: { vol: 0.8, prio: 5, win: 0.07, act: 1, crowd: 'clash', layers: [{ pool: 'clash', rate: [0.9, 1.1] }, { pool: 'clashHeavy', gain: 0.55, chance: 0.18, rate: [0.9, 1.05] }] },
    shield: { vol: 0.75, prio: 5, win: 0.08, act: 1, crowd: 'wood', layers: [{ pool: 'wood', rate: [0.85, 1.1] }] },
    flesh: { vol: 0.8, prio: 5, win: 0.08, act: 1, crowd: 'hit', layers: [{ pool: 'hit', rate: [0.88, 1.1] }, { pool: 'slash', gain: 0.4, chance: 0.45, rate: [0.9, 1.15] }] },
    block: { vol: 0.5, prio: 4, win: 0.18, act: 0.3, minG: 0.3, layers: [{ pool: 'wood', rate: [1.2, 1.45] }] },
    bow: { vol: 0.55, prio: 4, win: 0.1, act: 0.2, crowd: 'bow', volley: true, layers: [{ pool: 'bow', rate: [0.92, 1.08] }] },
    arrowhit: { vol: 0.6, prio: 4, win: 0.14, act: 0.3, crowd: 'arrowHit', layers: [{ pool: 'arrowHit', rate: [0.9, 1.2] }] },
    arrowground: { vol: 0.4, prio: 2, win: 0.12, act: 0.05, minG: 0.3, layers: [{ pool: 'arrowGround', rate: [1.0, 1.4] }] },
    pain: { vol: 0.5, prio: 4, win: 0.3, act: 0, chance: 0.5, minG: 0.3, layers: [{ pool: 'pain', rate: [0.93, 1.1] }] },
    death: { vol: 0.62, prio: 6, win: 0.13, act: 0.5, crowd: 'death', layers: [{ pool: 'death', rate: [0.92, 1.08] }, { pool: 'fall', gain: 0.45, chance: 0.55, rate: [0.9, 1.1], delay: [0.3, 0.55] }] },
    panic: { vol: 0.55, prio: 5, win: 0.8, act: 0, chance: 0.6, minG: 0.25, layers: [{ pool: 'scream', rate: [0.93, 1.1] }] },
    fall: { vol: 0.6, prio: 3, win: 0.15, act: 0, layers: [{ pool: 'fall', rate: [0.85, 1.05] }] },
    stomp: { vol: 0.75, prio: 4, win: 0.45, act: 1.5, max: 0.7, minG: 0.35, layers: [{ pool: 'thud', rate: [0.52, 0.62] }] },
    giant: { vol: 1.0, prio: 10, win: 0.05, act: 6, max: 1.4, duck: 0.35, layers: [{ pool: 'hitHeavy', rate: [0.72, 0.84] }, { pool: 'thud', gain: 0.9, rate: [0.48, 0.58] }, { pool: 'clashHeavy', gain: 0.35, chance: 0.5, rate: [0.7, 0.85] }, { pool: 'giantGrunt', gain: 0.6, chance: 0.4, rate: [0.85, 1.0] }] },
    giantdeath: { vol: 1.0, prio: 10, win: 0, act: 6, duck: 0.5, layers: [{ pool: 'giantRoar', rate: [0.82, 0.95] }, { pool: 'thud', gain: 1, rate: [0.42, 0.5], delay: [0.6, 0.8] }, { pool: 'hitHeavy', gain: 0.7, rate: [0.55, 0.65], delay: [0.62, 0.82] }] },
    charge: { vol: 0.9, prio: 8, win: 0.1, act: 4, max: 1.0, duck: 0.2, layers: [{ pool: 'hitHeavy', rate: [0.85, 1.0] }, { pool: 'armor', gain: 0.65, rate: [0.85, 1.05] }, { pool: 'neigh', gain: 0.5, chance: 0.22, rate: [0.95, 1.08], delay: [0.05, 0.2] }] },
    brace: { vol: 0.85, prio: 7, win: 0.15, act: 2, layers: [{ pool: 'wood', rate: [0.68, 0.8] }, { pool: 'hitHeavy', gain: 0.7, rate: [0.9, 1.05] }, { pool: 'neigh', gain: 0.75, chance: 0.6, rate: [1.0, 1.15], delay: [0.02, 0.1] }] },
    rout: { vol: 0.85, prio: 9, win: 1.5, act: 0, layers: [{ pool: 'scream', rate: [0.9, 1.05] }, { pool: 'scream', gain: 0.8, rate: [1.0, 1.15], delay: [0.15, 0.4] }, { pool: 'scream', gain: 0.6, rate: [0.95, 1.1], delay: [0.5, 0.9] }] },
    cheer: { vol: 0.85, prio: 9, win: 2, act: 0, layers: [{ pool: 'cheer' }, { pool: 'warcry', gain: 0.55, delay: [0.1, 0.4] }, { pool: 'warcry', gain: 0.5, delay: [0.5, 1.0] }, { pool: 'warcry', gain: 0.45, delay: [1.0, 1.6] }] },
    hoof: { feed: 'gallop' }, // galloping knights drive the cavalry bed instead of single hoof clicks
  };
  const NAMES = Object.keys(EVENTS);
  const NT = NAMES.length;
  const TI = {};
  NAMES.forEach((n, i) => { TI[n] = i; });
  const CELL = 200, COLS = Math.ceil(C.WORLD_W / CELL), ROWS = Math.ceil(C.WORLD_H / CELL), NC = COLS * ROWS;
  const MAX_VOICES = 36, RESERVE = 6, MAX_NEW = 10;
  // global budget of new voices per second (token bucket): a massacre stays a texture, not a machine gun
  const RATE = 70, BURST = 14;
  // pools that get pre-mixed crowd variants: [pool, takes in "m", takes in "l", spread seconds]
  const CROWDS = [['clash', 4, 10, 0.35], ['hit', 4, 9, 0.35], ['wood', 3, 7, 0.3], ['bow', 4, 10, 0.45], ['arrowHit', 4, 10, 0.4], ['death', 3, 5, 0.5]];

  const Audio = {
    ctx: null, ready: false, loading: null, failed: false, live: false,
    muted: false, volume: 0.8,
    pools: {}, beds: {}, crowds: {}, bags: {},
    voices: [], bedNodes: null,
    now: 0, lx: 1200, ly: 750, Rv: 800, halfW: 800, zoom: 1,
    actAcc: 0, act: 0, gallopAcc: 0, gallop: 0, tokens: 16,
    cnt: new Float32Array(NT * NC), sx: new Float32Array(NT * NC), sy: new Float32Array(NT * NC),
    t0: new Float64Array(NT * NC), next: new Float64Array(NT * NC),
    stats: { started: 0, dropped: 0, stolen: 0, maxActive: 0, byType: {}, frameMs: 0, frames: 0 },
    clock: null, onChange: null, lastBattle: null, phase: 'setup',

    // ---------------------------------------------------------------- loading (no gesture needed)
    load() {
      if (this.loading) return this.loading;
      const bank = TM.SOUND_BANK;
      if (!bank || !bank.sounds) { this.failed = true; console.warn('TOTAL MASSACRE: js/sound-data.js missing, sound disabled'); return (this.loading = Promise.resolve(false)); }
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OAC) { this.failed = true; return (this.loading = Promise.resolve(false)); }
      const t0 = performance.now();
      this.loading = (async () => {
        const dec = new OAC(1, 1, SR);
        const list = bank.sounds;
        let i = 0;
        const worker = async () => {
          while (i < list.length) {
            const [id, cat, b64, loop] = list[i++];
            try {
              const raw = await decode(dec, b64);
              if (cat === 'bed') this.beds[id.replace('bed_', '')] = loop ? loopExact(raw, loop) : raw;
              else (this.pools[cat] || (this.pools[cat] = [])).push(trimLead(raw));
            } catch (e) { console.warn('sound decode failed:', id, e); }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        await this.buildDerived(OAC);
        this.ready = true;
        this.loadMs = performance.now() - t0;
        if (this.ctx) this.startBeds();
        if (this.onChange) this.onChange();
        return true;
      })().catch((e) => { this.failed = true; console.warn('sound init failed', e); return false; });
      return this.loading;
    },

    // Pre-mixed variants rendered offline from the real takes: dense "crowd" hits and a looping melee din.
    async buildDerived(OAC) {
      const jobs = [];
      for (const [pool, m, l, spread] of CROWDS) {
        const src = this.pools[pool];
        if (!src || !src.length) continue;
        const c = this.crowds[pool] = { m: [], l: [] };
        for (let v = 0; v < 3; v++) {
          jobs.push(mixCrowd(OAC, src, m, spread * 0.6).then((b) => c.m.push(b)));
          jobs.push(mixCrowd(OAC, src, l, spread).then((b) => c.l.push(b)));
        }
      }
      // melee din: a 10 s loop of distant clashes and blows (granular scatter of the real recordings)
      const parts = [].concat(this.pools.clash || [], this.pools.hit || [], this.pools.wood || [], this.pools.clashHeavy || []);
      if (parts.length) jobs.push(renderDin(OAC, parts).then((b) => { this.beds.din = b; }));
      await Promise.all(jobs);
    },

    // ---------------------------------------------------------------- settings
    loadSettings() {
      try {
        const s = JSON.parse(localStorage.getItem(STORE));
        if (s) { this.volume = clamp(+s.v, 0, 1); this.muted = !!s.m; }
      } catch (e) { /* ignore */ }
    },
    saveSettings() { try { localStorage.setItem(STORE, JSON.stringify({ v: this.volume, m: this.muted })); } catch (e) { /* ignore */ } },

    // Browsers only allow audio output after a user gesture: call from input handlers.
    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try { this.attach(new AC({ latencyHint: 'interactive' })); } catch (e) { return; }
      }
      if (this.ctx.state !== 'running' && !this.muted) this.ctx.resume().catch(() => {});
    },

    // Attach any (Offline)AudioContext. opts.clock: virtual clock for offline tests.
    attach(ctx, opts) {
      opts = opts || {};
      this.ctx = ctx;
      this.clock = opts.clock || (() => ctx.currentTime);
      // voices -> bus (+ reverb send) ; beds -> bedBus ; both -> compressor -> master -> limiter -> out
      this.bus = ctx.createGain(); this.bus.gain.value = 0.8;
      this.bedBus = ctx.createGain(); this.bedBus.gain.value = 1;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -18; this.comp.knee.value = 12; this.comp.ratio.value = 4;
      this.comp.attack.value = 0.005; this.comp.release.value = 0.25;
      this.master = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -2; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002; this.limiter.release.value = 0.15;
      this.bus.connect(this.comp); this.bedBus.connect(this.comp);
      this.comp.connect(this.master); this.master.connect(this.limiter); this.limiter.connect(ctx.destination);
      // open-field reverb: short diffuse tail that glues distant sounds into one space
      this.verb = ctx.createConvolver();
      this.verb.buffer = makeIR(ctx, 1.5);
      this.verbGain = ctx.createGain(); this.verbGain.gain.value = 0.55;
      this.verb.connect(this.verbGain); this.verbGain.connect(this.comp);
      this.applyVolume(true);
      if (this.ready) this.startBeds();
      else this.load();
    },

    applyVolume(instant) {
      if (!this.master) return;
      const v = this.muted ? 0 : this.volume * this.volume; // perceptual taper
      const t = this.clock();
      this.master.gain.cancelScheduledValues(t);
      if (instant) this.master.gain.value = v; else this.master.gain.setTargetAtTime(v, t, 0.04);
    },
    setVolume(v) { this.volume = clamp(v, 0, 1); this.applyVolume(); this.saveSettings(); if (this.onChange) this.onChange(); },
    setMuted(m) {
      this.muted = !!m;
      this.applyVolume();
      if (this.ctx && this.ctx.suspend) {
        if (this.muted) setTimeout(() => { if (this.muted && this.ctx.state === 'running') this.ctx.suspend(); }, 250);
        else this.unlock();
      }
      if (!this.muted && !this.ctx) this.unlock();
      this.saveSettings(); if (this.onChange) this.onChange();
    },
    toggleMute() { this.setMuted(!this.muted); },

    // ---------------------------------------------------------------- events from the simulation
    emit(k, x, y) {
      const t = TI[k];
      if (t === undefined) return;
      const ev = EVENTS[k];
      const d = Math.hypot(x - this.lx, y - this.ly) / this.Rv, w = 1 / (1 + 2.25 * d * d);
      if (ev.feed) { this.gallopAcc += w; return; }
      let cx = (x / CELL) | 0, cy = (y / CELL) | 0;
      cx = cx < 0 ? 0 : cx >= COLS ? COLS - 1 : cx; cy = cy < 0 ? 0 : cy >= ROWS ? ROWS - 1 : cy;
      const i = t * NC + cy * COLS + cx;
      if (this.cnt[i] === 0) this.t0[i] = this.now;
      if (this.cnt[i] < 90) this.cnt[i]++;
      this.sx[i] += x; this.sy[i] += y;
      if (ev.act) this.actAcc += ev.act * w;
    },

    // ---------------------------------------------------------------- start-of-battle cues
    // Red horn, blue answers, then both armies roar and the drums start.
    battleStart(B) {
      if (this.muted) return;
      if (!this.ready || !this.ctx) { this.pendingStart = { B, t: performance.now() }; return; }
      this.pendingStart = null;
      const now = this.clock();
      // a quick restart must not stack horns on top of the previous ones: fade the old cue out
      for (const v of this.cue || []) {
        try { v.g.gain.cancelScheduledValues(now); v.g.gain.setTargetAtTime(0, now, 0.05); v.src.stop(now + 0.3); } catch (e) { /* already ended */ }
        const i = this.voices.indexOf(v);
        if (i >= 0) this.voices.splice(i, 1);
      }
      const first = this.voices.length;
      const c = B && B.center ? B.center : [{ x: C.WORLD_W * 0.3, y: C.WORLD_H / 2 }, { x: C.WORLD_W * 0.7, y: C.WORLD_H / 2 }];
      const horns = this.pools.horn || [];
      if (horns.length) {
        this.voice(horns[0], 0.6, this.panOf(c[0].x) * 0.8, 16000, 1, now + 0.05, 'horn', 10, { send: 0.35 });
        this.voice(horns[horns.length > 1 ? 1 : 0], 0.6, this.panOf(c[1].x) * 0.8, 14000, 0.96, now + 1.7, 'horn', 10, { send: 0.45 });
      }
      for (let t = 0; t < 2; t++) for (let k = 0; k < 3; k++) {
        const b = this.pick('warcry');
        if (b) this.voice(b, 0.32, this.panOf(c[t].x) * 0.7 + rnd(-0.15, 0.15), 9000, rnd(0.92, 1.06), now + 3.3 + t * 0.25 + k * rnd(0.12, 0.35), 'warcry', 6, { send: 0.4 });
      }
      this.cue = this.voices.slice(first);
      this.drumT = now + 2.6; // drums swell in as the armies set off
    },
    horn() { this.battleStart(TM.Game && TM.Game.battle); }, // backwards-compatible alias

    // ---------------------------------------------------------------- per-frame mixing
    // cam: {x, y, zoom/ez}; active: battle running and unpaused; B: battle (read-only)
    frame(dtReal, speed, cam, vw, vh, active, B) {
      if (!this.ready || !this.ctx) { this.live = false; return; }
      const T0 = performance.now();
      const now = this.clock();
      this.now = now;
      const z = cam.ez || cam.zoom || 1;
      this.lx = cam.x; this.ly = cam.y; this.zoom = z;
      this.halfW = vw / 2 / z;
      this.Rv = Math.hypot(vw, vh) / 2 / z;
      this.live = !this.muted && active;
      this.tokens = Math.min(BURST, this.tokens + dtReal * RATE);
      // the start cue is only worth playing if decoding finished within a moment of the start
      if (this.pendingStart && this.live) { const p = this.pendingStart; this.pendingStart = null; if (performance.now() - p.t < 1500) this.battleStart(p.B); }
      this.voices = this.voices.filter((v) => v.end > now);

      // smoothed intensities (per simulated second, weighted by distance to the camera)
      const dtSim = Math.max(0.004, dtReal * (active ? speed : 0));
      const inst = active ? this.actAcc / dtSim : 0, gi = active ? this.gallopAcc / dtSim : 0;
      this.actAcc = 0; this.gallopAcc = 0;
      this.act += (inst - this.act) * (1 - Math.exp(-dtReal / (inst > this.act ? 0.5 : 1.4)));
      this.gallop += (gi - this.gallop) * (1 - Math.exp(-dtReal / (gi > this.gallop ? 0.25 : 0.6)));
      this.updateBeds(now, B, active, z);

      if (!this.live) {
        if (this.cnt.some((c) => c)) { this.cnt.fill(0); this.sx.fill(0); this.sy.fill(0); }
        this.statFrame(T0);
        return;
      }

      const cands = [];
      const zf = 0.6 + 0.4 * clamp(z, 0, 1);
      for (let t = 0; t < NT; t++) {
        const ev = EVENTS[NAMES[t]];
        if (ev.feed) continue;
        for (let c = 0; c < NC; c++) {
          const i = t * NC + c, n = this.cnt[i];
          if (!n) continue;
          if (now - this.t0[i] > 0.7) { this.cnt[i] = 0; this.sx[i] = 0; this.sy[i] = 0; continue; } // stale
          if (now < this.next[i]) continue;
          const px = this.sx[i] / n, py = this.sy[i] / n;
          const d = Math.hypot(px - this.lx, py - this.ly) / this.Rv;
          const g = 1 / (1 + 2.25 * d * d);
          // far-away details are left to the ambience beds
          if (g * ev.vol < 0.1 || g < (ev.minG != null ? ev.minG : ev.prio < 5 ? 0.25 : 0)) { this.cnt[i] = 0; this.sx[i] = 0; this.sy[i] = 0; this.stats.dropped++; continue; }
          // waiting raises priority, so frequent quiet events can't starve rarer ones
          cands.push({ i, t, n, px, py, g, score: ev.prio * g * (1 + 0.3 * Math.log2(1 + n)) * (1 + 4 * (now - this.t0[i])) });
        }
      }
      if (cands.length) {
        cands.sort((a, b) => b.score - a.score);
        let made = 0;
        for (const c of cands) {
          if (made >= MAX_NEW) { this.stats.dropped++; break; }
          const ev = EVENTS[NAMES[c.t]];
          const clear = () => { this.cnt[c.i] = 0; this.sx[c.i] = 0; this.sy[c.i] = 0; this.next[c.i] = now + ev.win; };
          if (ev.chance != null && Math.random() > ev.chance) { clear(); continue; }
          if (this.voices.length >= MAX_VOICES - RESERVE && ev.prio <= 3) continue; // headroom for important sounds
          if (ev.prio < 9 && this.tokens < 1) { this.stats.dropped++; continue; }    // rate budget (signals bypass it)
          // strict cap: every layer needs a slot; only important events may cut minor ones
          const need = ev.layers.length + (ev.volley ? 1 : 0);
          while (this.voices.length + need > MAX_VOICES && ev.prio >= 6 && this.steal(ev.prio));
          if (this.voices.length + need > MAX_VOICES) { this.stats.dropped++; continue; }
          const v0 = this.stats.started;
          this.playEvent(NAMES[c.t], ev, c, speed, zf, now);
          if (ev.prio < 9) this.tokens -= this.stats.started - v0;
          made++;
          clear();
        }
      }
      this.statFrame(T0);
    },

    statFrame(T0) {
      const s = this.stats, ms = performance.now() - T0;
      s.frames++; s.frameMs += (ms - s.frameMs) * 0.05;
      if (this.voices.length > s.maxActive) s.maxActive = this.voices.length;
    },

    panOf(x) { return clamp((x - this.lx) / (this.halfW * 1.3 + 1), -1, 1) * 0.85; },

    // shuffle bag: every take is used once before any repeats
    pick(pool) {
      const arr = this.pools[pool];
      if (!arr || !arr.length) return null;
      let bag = this.bags[pool];
      if (!bag || !bag.length) {
        bag = this.bags[pool] = arr.map((_, i) => i);
        for (let i = bag.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = bag[i]; bag[i] = bag[j]; bag[j] = t; }
        if (bag.length > 1 && bag[bag.length - 1] === this.bags['_last' + pool]) { const t = bag[0]; bag[0] = bag[bag.length - 1]; bag[bag.length - 1] = t; }
      }
      const idx = bag.pop();
      this.bags['_last' + pool] = idx;
      return arr[idx];
    },

    playEvent(k, ev, c, speed, zf, now) {
      const ne = c.n / Math.max(1, speed); // events in this window, normalised for fast-forward
      const tier = ne >= 9 ? 'l' : ne >= 3 ? 'm' : 's';
      const z = this.zoom;
      const zoomGain = clamp(0.82 + 0.22 * Math.sqrt(z), 0.82, 1.2);
      const mag = 0.55 + 0.45 * Math.min(1, Math.log2(1 + ne) / 4);
      const base = ev.vol * c.g * zoomGain * mag;
      const pan = this.panOf(c.px);
      const cutoff = (600 + 18000 * Math.pow(c.g, 0.85)) * zf;
      const send = 0.12 + 0.5 * (1 - c.g);
      const slow = speed < 1 ? 0.8 + 0.2 * speed : 1;
      const t0 = now + Math.random() * 0.015;
      for (let li = 0; li < ev.layers.length; li++) {
        const L = ev.layers[li];
        if (L.chance != null && Math.random() > L.chance) continue;
        let buf = null;
        if (li === 0 && ev.crowd && tier !== 's' && this.crowds[ev.crowd]) {
          const arr = this.crowds[ev.crowd][tier];
          if (arr.length) buf = arr[(Math.random() * arr.length) | 0];
        }
        if (!buf) buf = this.pick(L.pool);
        if (!buf) continue;
        const r = L.rate ? rnd(L.rate[0], L.rate[1]) : 1;
        const delay = L.delay ? rnd(L.delay[0], L.delay[1]) : 0;
        const gj = Math.pow(10, rnd(-1.5, 1.5) / 20); // ±1.5 dB
        this.voice(buf, base * (L.gain || 1) * gj, pan + rnd(-0.06, 0.06), cutoff, r * slow, t0 + delay, k, ev.prio, { send, max: ev.max });
      }
      // a volley: arrows whistle overhead shortly after a crowd of archers looses
      if (ev.volley && tier !== 's' && c.g > 0.35) {
        const b = this.pick('arrowFly');
        if (b) this.voice(b, base * 0.5, pan * 0.5, cutoff, rnd(0.95, 1.08), t0 + rnd(0.15, 0.35), 'arrowFly', 3, { send: send + 0.1 });
      }
      if (ev.duck && c.g > 0.4) this.duck(ev.duck * c.g, now);
    },

    // Free a voice slot by fading out the least important (oldest on ties) voice.
    steal(prio) {
      let worst = null;
      for (const v of this.voices) if (v.prio <= prio - 2 && (!worst || v.prio < worst.prio || (v.prio === worst.prio && v.start < worst.start))) worst = v;
      if (!worst) return false;
      const t = this.clock();
      try { worst.g.gain.cancelScheduledValues(t); worst.g.gain.setTargetAtTime(0, t, 0.015); worst.src.stop(t + 0.08); } catch (e) { /* already stopped */ }
      this.voices.splice(this.voices.indexOf(worst), 1);
      this.stats.stolen++;
      return true;
    },

    voice(buf, gain, pan, cutoff, rate, when, k, prio, o) {
      const ctx = this.ctx;
      o = o || {};
      const src = ctx.createBufferSource();
      src.buffer = buf; src.playbackRate.value = rate;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = clamp(cutoff, 300, 20000); lp.Q.value = 0.4;
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(lp); lp.connect(g);
      let out = g, p = null, s = null;
      if (ctx.createStereoPanner) { p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); out = p; }
      out.connect(this.bus);
      if (o.send && this.verb) { s = ctx.createGain(); s.gain.value = o.send; out.connect(s); s.connect(this.verb); }
      src.start(when);
      let len = buf.duration / rate;
      if (o.max && len > o.max) {
        // long tails (booms, roars) are cut with a short fade so they don't hog voice slots
        g.gain.setValueAtTime(gain, when + o.max - 0.15);
        g.gain.linearRampToValueAtTime(0, when + o.max);
        src.stop(when + o.max + 0.02);
        len = o.max;
      }
      // release every node of the voice when it ends (an orphaned send gain would keep processing)
      src.onended = () => { for (const nd of [src, lp, g, p, s]) if (nd) { try { nd.disconnect(); } catch (e) { /* ignore */ } } };
      this.voices.push({ end: when + len, prio: prio || 5, start: when, g, src });
      this.stats.started++;
      this.stats.byType[k] = (this.stats.byType[k] || 0) + 1;
    },

    // ---------------------------------------------------------------- beds
    startBeds() {
      if (this.bedNodes || !this.ready || !this.ctx) return;
      const ctx = this.ctx;
      const mk = (name, offset) => {
        const b = this.beds[name];
        if (!b) return null;
        const src = ctx.createBufferSource(); src.buffer = b; src.loop = true;
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 12000; f.Q.value = 0.5;
        const g = ctx.createGain(); g.gain.value = 0;
        src.connect(f); f.connect(g);
        let p = null;
        if (ctx.createStereoPanner) { p = ctx.createStereoPanner(); g.connect(p); p.connect(this.bedBus); } else g.connect(this.bedBus);
        src.start(0, (offset || 0) % b.duration);
        return { g, f, p, level: 0 };
      };
      this.bedNodes = {
        wind: mk('wind'), march: mk('march', 1.3), drums: mk('drums'), gallop: mk('gallop', 0.7), herd: mk('herd', 2.1),
        roarA: mk('roarA'), roarB: mk('roarB', 4.4), din: mk('din', 2.2), panic: mk('panic', 1.7),
      };
      if (this.bedNodes.roarA && this.bedNodes.roarA.p) this.bedNodes.roarA.p.pan.value = -0.35;
      if (this.bedNodes.roarB && this.bedNodes.roarB.p) this.bedNodes.roarB.p.pan.value = 0.35;
    },

    // Bed levels follow what is on screen: who marches, gallops, fights or runs, and where.
    updateBeds(now, B, active, z) {
      const N = this.bedNodes;
      if (!N) return;
      let march = 0, mx = 0, flee = 0, fx = 0, gal = 0, gx = 0, alive = 0;
      if (B && (active || B.state === 'deploy' || B.state === 'over')) {
        const R = this.Rv, lx = this.lx, ly = this.ly;
        for (let t = 0; t < 2; t++) {
          const list = B.alive[t];
          for (let i = 0; i < list.length; i++) {
            const u = list[i];
            const dx = (u.x - lx) / R, dy = (u.y - ly) / R, w = 1 / (1 + 2.25 * (dx * dx + dy * dy));
            alive += w;
            if (u.fleeing) { flee += w; fx += w * u.x; }
            else if (u.def.mounted && u.moveAmt > 0.55) { gal += w; gx += w * u.x; }
            else if (!u.target && u.moveAmt > 0.3) { march += w * (u.type === 'giant' ? 3 : 1); mx += w * u.x; }
          }
        }
      }
      const running = active && B && B.state === 'running';
      const contact = B && (B.contact[0] || B.contact[1]);
      const sat = (v, k) => 1 - Math.exp(-v / k);
      const a = this.act;
      const T = {
        wind: this.phase === 'setup' || !B || B.state === 'deploy' ? 0.5 : 0.28 * (1 - 0.6 * sat(a, 80)),
        march: running ? 0.55 * sat(march, 35) : 0,
        drums: running && !contact && this.drumT && now > this.drumT ? 0.45 : 0,
        gallop: running ? 0.6 * sat(this.gallop + gal * 0.6, 10) : 0,
        herd: running ? 0.55 * sat(gal, 25) : 0,
        roarA: running ? 0.5 * sat(a, 50) : 0,
        roarB: running ? 0.45 * sat(a, 140) : 0,
        din: running ? 0.6 * sat(a, 70) : 0,
        panic: running ? 0.5 * sat(flee, 10) : 0,
      };
      // gentle fade of everything but wind while paused / after the battle
      const cut = 3000 + 9000 * clamp(0.4 + 0.6 * z, 0, 1);
      // automation events are only scheduled when a value really changes (no per-frame spam)
      for (const k in N) {
        const n = N[k];
        if (!n) continue;
        const target = T[k] || 0;
        if (Math.abs(target - n.level) > 0.012 || (target === 0 && n.level !== 0)) {
          const tc = target > n.level ? 0.6 : (k === 'drums' ? 2.5 : 1.2);
          n.g.gain.cancelScheduledValues(now);
          n.g.gain.setTargetAtTime(target, now, tc);
          n.level = target;
        }
        if (k !== 'wind' && Math.abs(cut - (n.cut || 0)) > n.cut * 0.06) { n.f.frequency.setTargetAtTime(cut, now, 0.4); n.cut = cut; }
      }
      const pan = (sum, w) => (w > 0.001 ? this.panOf(sum / w) * 0.7 : 0);
      const setPan = (n, v) => { if (n && n.p && Math.abs(v - (n.pan || 0)) > 0.04) { n.p.pan.setTargetAtTime(v, now, 0.4); n.pan = v; } };
      setPan(N.march, pan(mx, march)); setPan(N.gallop, pan(gx, gal)); setPan(N.herd, pan(gx, gal) * 0.6); setPan(N.panic, pan(fx, flee));
      void alive;
    },

    // short dip of the beds under a huge impact: makes giants and charges punch through
    duck(amount, now) {
      const g = this.bedBus.gain;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(1 - clamp(amount, 0, 0.6), now, 0.01);
      g.setTargetAtTime(1, now + 0.12, 0.35);
    },

    setPhase(p) { this.phase = p; if (p !== 'battle') this.drumT = 0; },

    // ---------------------------------------------------------------- UI binding
    bindUI() {
      this.loadSettings();
      this.load();
      const btn = document.getElementById('btn-snd'), vol = document.getElementById('snd-vol');
      const sync = () => {
        if (!btn) return;
        btn.textContent = this.failed ? '✖' : this.muted || this.volume === 0 ? '🔇' : this.volume < 0.4 ? '🔈' : this.volume < 0.75 ? '🔉' : '🔊';
        btn.classList.toggle('off', this.muted || this.failed);
        btn.title = this.failed ? 'Звук недоступен в этом браузере' : this.muted ? 'Звук выключен (M)' : this.ctx && this.ctx.state === 'suspended' ? 'Нажмите, чтобы включить звук (M — выкл.)' : 'Звук включён (M — выкл.)';
        vol.value = Math.round(this.volume * 100);
      };
      this.onChange = sync;
      btn.addEventListener('click', () => { this.unlock(); this.toggleMute(); });
      vol.addEventListener('input', () => { if (this.muted && +vol.value > 0) this.setMuted(false); else this.unlock(); this.setVolume(+vol.value / 100); });
      // autoplay policy: the first gesture creates / resumes the context
      const gesture = () => { if (!this.muted) this.unlock(); };
      window.addEventListener('pointerdown', gesture, true);
      window.addEventListener('keydown', gesture, true);
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        if (document.hidden) this.ctx.suspend(); else if (!this.muted) this.ctx.resume().catch(() => {});
      });
      sync();
    },
  };

  // ------------------------------------------------------------------ helpers
  function b64ToBuf(b64) {
    const s = atob(b64), n = s.length, u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = s.charCodeAt(i);
    return u.buffer;
  }
  function decode(ctx, b64) {
    const ab = b64ToBuf(b64);
    return new Promise((res, rej) => {
      const p = ctx.decodeAudioData(ab, res, rej); // callback form for older Safari
      if (p && p.catch) p.catch(rej);
    });
  }
  // MP3 encoder/decoder delay adds ~25 ms of silence at the start: cut it for instant response
  function trimLead(buf) {
    const d = buf.getChannelData(0);
    let i = 0;
    while (i < d.length && Math.abs(d[i]) < 0.0004) i++;
    i = Math.max(0, i - 16);
    if (i < 32) return buf;
    const out = new AudioBuffer({ length: buf.length - i, sampleRate: buf.sampleRate, numberOfChannels: 1 });
    out.copyToChannel(d.subarray(i), 0);
    return out;
  }
  // MP3 has no exact length: decoders add codec delay at the start and padding at the end (and the
  // delay differs between encoders/bitrates/browsers), which would put a gap into every loop. Find
  // where the original loop starts (normalised cross-correlation with its first samples, stored by the
  // pipeline) and cut exactly `samples` samples.
  function loopExact(buf, meta) {
    const d = buf.getChannelData(0), h = meta.head, n = meta.samples, H = Math.min(h.length, 512);
    const maxOff = Math.min(12000, d.length - n); // codec delay + the pipeline's 4096-sample wrap padding
    if (!h || maxOff < 0) return buf;
    // normalised correlation, so loud passages can't win over the true (maybe quiet) start
    let best = 0, bestScore = -Infinity, e = 0;
    for (let i = 0; i < H; i++) e += d[i] * d[i];
    for (let k = 0; k <= maxOff; k++) {
      let sc = 0;
      for (let i = 0; i < H; i++) sc += d[k + i] * h[i];
      sc /= Math.sqrt(e) + 1e-9;
      if (sc > bestScore) { bestScore = sc; best = k; }
      e += d[k + H] * d[k + H] - d[k] * d[k]; // slide the window energy
    }
    // the pipeline encodes [tail | loop | head], so the codec's edge errors lie outside this slice
    // and the loop point is as clean as any other sample of the stream
    const y = d.slice(best, best + n);
    const out = new AudioBuffer({ length: n, sampleRate: buf.sampleRate, numberOfChannels: 1 });
    out.copyToChannel(y, 0);
    out.loopOffset = best; // for diagnostics
    return out;
  }
  function shuffled(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  // n real takes layered with random offsets/pitch/gain -> one dense buffer
  async function mixCrowd(OAC, src, n, spread) {
    const len = Math.ceil((spread + 1.0) * SR);
    const ctx = new OAC(1, len, SR);
    const takes = shuffled(src);
    for (let i = 0; i < n; i++) {
      const b = takes[i % takes.length];
      const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rnd(0.88, 1.12);
      const g = ctx.createGain(); g.gain.value = (i === 0 ? 1 : rnd(0.35, 0.8)) / Math.sqrt(1 + n * 0.35);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = i === 0 ? 18000 : rnd(3500, 12000);
      s.connect(f); f.connect(g); g.connect(ctx.destination);
      s.start(i === 0 ? 0 : Math.pow(Math.random(), 0.7) * spread);
    }
    return normalizeTail(await ctx.startRendering());
  }
  // looping distant melee: ~22 blows per second scattered over 10 s, then wrapped seamlessly
  async function renderDin(OAC, parts) {
    const dur = 10, len = dur * SR, total = len + SR;
    const ctx = new OAC(1, total, SR);
    for (let i = 0; i < dur * 22; i++) {
      const b = parts[(Math.random() * parts.length) | 0];
      const s = ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rnd(0.82, 1.15);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = rnd(1800, 7000);
      const g = ctx.createGain(); g.gain.value = Math.pow(Math.random(), 1.6) * 0.5 + 0.05;
      s.connect(f); f.connect(g); g.connect(ctx.destination);
      s.start(Math.random() * dur);
    }
    const r = await ctx.startRendering(), d = r.getChannelData(0);
    // fold the overhanging tail back onto the start: the loop has no seam
    const out = new AudioBuffer({ length: len, sampleRate: SR, numberOfChannels: 1 }), o = out.getChannelData(0);
    for (let i = 0; i < len; i++) o[i] = d[i] + (i < total - len ? d[len + i] : 0);
    let pk = 0; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(o[i]));
    if (pk > 0) for (let i = 0; i < len; i++) o[i] *= 0.7 / pk;
    return out;
  }
  function normalizeTail(buf) {
    const d = buf.getChannelData(0);
    let pk = 0, last = 0;
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; }
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > pk * 0.003) last = i;
    const len = Math.min(d.length, last + 64);
    const out = new AudioBuffer({ length: len, sampleRate: buf.sampleRate, numberOfChannels: 1 }), o = out.getChannelData(0);
    const k = pk > 0 ? 0.89 / pk : 1;
    for (let i = 0; i < len; i++) o[i] = d[i] * k * (i > len - 256 ? (len - i) / 256 : 1);
    return out;
  }
  // stereo impulse response: decorrelated noise, exponential decay, darker towards the end
  function makeIR(ctx, sec) {
    const sr = ctx.sampleRate, n = Math.floor(sec * sr), b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, k = 0.35 + 0.6 * Math.exp(-t * 3);
        lp += (Math.random() * 2 - 1 - lp) * k;
        d[i] = (t < 0.012 ? 0 : lp) * Math.exp(-t * 4.2);
      }
    }
    return b;
  }

  Audio.EVENTS = EVENTS;
  TM.Audio = Audio;
})(window.TM = window.TM || {});
