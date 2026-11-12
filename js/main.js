// Game controller: setup state, main loop (fixed step), input handling.
(function (TM) {
  'use strict';
  const C = TM.CONFIG;
  const STORE_KEY = 'total-massacre-setup-v1';

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function defaultSetup() {
    const p = TM.PRESETS[0];
    return { armies: [clone(p.red), clone(p.blue)], morale: true, friendlyFire: true };
  }

  function loadSetup() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && s.armies && s.armies.length === 2) {
        for (const a of s.armies) {
          for (const k of TM.UNIT_ORDER) a.counts[k] = Math.min(TM.UNIT_TYPES[k].max, a.counts[k] | 0);
          TM.Groups.sanitize(a);
          if (!TM.FORMATIONS.some((f) => f.key === a.formation)) a.formation = 'line';
        }
        return s;
      }
    } catch (e) { /* ignore */ }
    return defaultSetup();
  }

  const Game = {
    setup: null,
    fx: null, renderer: null, cam: null, battle: null,
    mode: 'setup',
    paused: false,
    speed: 1,
    acc: 0,
    last: 0,
    dirty: false,
    hover: null,
    resultShown: false,
    keys: {},
    fps: 60,
    stepMs: 0,

    init() {
      this.setup = loadSetup();
      TM.Sprites.init();
      console.log(`Sprites generated in ${TM.Sprites.genMs.toFixed(0)} ms`);
      this.fx = new TM.Effects();
      this.renderer = new TM.Render.Renderer(document.getElementById('view'));
      this.cam = new TM.Camera();
      this.cam.dpr = this.renderer.dpr;
      TM.UI.init(this);
      this.newBattle();
      this.fit();
      this.bindInput();
      TM.UI.setMode('setup');
      TM.UI.syncControls();
      this.debugParams();
      requestAnimationFrame((t) => this.frame(t));
    },

    // ---------------- state transitions ----------------
    newBattle() {
      this.fx.reset();
      this.battle = new TM.Battle(clone(this.setup), this.fx);
      this.acc = 0;
      this.resultShown = false;
      this.hover = null;
      this.cam.follow = null;
      this.cam.followReg = null;
      this.cam.aim = null;
      this.slowT = 0; this.endSeen = false;
      TM.UI.updateHud(this.battle, true);
    },

    // opts.keepView: don't re-frame the camera (hand editing keeps the view where the user put it)
    setupChanged(opts) {
      this.dirty = true;
      if (!(opts && opts.keepView)) this.needFit = true;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(this.setup)); } catch (e) { /* ignore */ }
    },

    applyPreset(p) {
      this.setup.armies = [clone(p.red), clone(p.blue)];
      TM.UI.syncFromSetup();
      this.setupChanged();
    },

    start() {
      if (this.mode !== 'setup') return;
      const s = this.battle.stats;
      if (!s[0].deployed || !s[1].deployed) return;
      if (this.dirty) { this.newBattle(); this.dirty = false; }
      this.mode = 'battle';
      this.paused = false;
      this.cam.auto = true;
      this.cam.follow = null;
      this.battle.start();
      TM.Audio.setPhase('battle');
      TM.Audio.battleStart(this.battle);
      TM.UI.setMode('battle');
      TM.UI.syncControls();
      this.announce();
    },

    // "To battle!" with the size of the armies
    announce() {
      const s = this.battle.stats;
      TM.UI.banner('К БОЮ!', `${s[0].deployed} против ${s[1].deployed}`);
    },

    restart() {
      this.newBattle();
      this.mode = 'battle';
      this.paused = false;
      this.cam.auto = true;
      this.battle.start();
      TM.Audio.setPhase('battle');
      TM.Audio.battleStart(this.battle);
      TM.UI.hideResult();
      TM.UI.setMode('battle');
      TM.UI.syncControls();
      this.announce();
    },

    toSetup() {
      TM.Audio.setPhase('setup');
      this.mode = 'setup';
      this.cam.auto = false;
      this.newBattle();
      TM.UI.setMode('setup');
      TM.UI.syncControls();
      this.fit();
    },

    togglePause() {
      if (this.mode !== 'battle') return;
      this.paused = !this.paused;
      TM.UI.syncControls();
    },

    setSpeed(s) {
      this.speed = s;
      TM.UI.syncControls();
    },

    toggleAuto() {
      this.cam.auto = !this.cam.auto;
      if (this.cam.auto) { this.cam.follow = null; this.cam.followReg = null; this.cam.aim = null; this.cam.stop(); }
      TM.UI.syncControls();
    },

    fit() {
      this.cam.auto = false;
      this.cam.follow = null;
      this.cam.followReg = null;
      const R = this.renderer;
      if (this.mode === 'setup') {
        const side = R.vw > 1100 ? 340 : R.vw > 800 ? 300 : 0;
        this.cam.fit(R.vw, R.vh, this.armyRect(), { l: side, r: side, t: 90, b: 140 });
      } else {
        this.cam.fit(R.vw, R.vh, null, { l: 0, r: 0, t: 80, b: 60 }, true);
      }
      TM.UI.syncControls();
    },

    toggleTactics() {
      this.renderer.showTactics = !this.renderer.showTactics;
      TM.UI.syncControls();
    },

    // fly the camera to a point of the field (event feed, minimap, regiment chips)
    flyTo(x, y, zoom) {
      this.cam.auto = false;
      this.cam.follow = null;
      this.cam.followReg = null;
      this.cam.flyTo(x, y, zoom);
      TM.UI.syncControls();
    },

    // Bounding box of both deployed armies (symmetric around the centre line).
    armyRect() {
      const cx = C.WORLD_W / 2, cy = C.WORLD_H / 2;
      let hw = 420, hh = 260;
      if (this.setup.armies.some((a) => a.formation === 'manual')) {
        // hand-placed armies can be anywhere: frame their actual bounding box
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const u of this.battle.units) { x0 = Math.min(x0, u.x); x1 = Math.max(x1, u.x); y0 = Math.min(y0, u.y); y1 = Math.max(y1, u.y); }
        if (x1 < x0) return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
        const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        const w = Math.max(700, x1 - x0 + 140), h = Math.max(450, y1 - y0 + 140);
        return { x0: mx - w / 2, y0: my - h / 2, x1: mx + w / 2, y1: my + h / 2 };
      }
      for (const u of this.battle.units) {
        hw = Math.max(hw, Math.abs(u.x - cx) + 50);
        hh = Math.max(hh, Math.abs(u.y - cy) + 50);
      }
      return { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
    },

    // ---------------- main loop ----------------
    frame(ts) {
      const dtReal = Math.min(0.1, (ts - (this.last || ts)) / 1000);
      this.last = ts;
      if (dtReal > 0) this.fps += (1 / dtReal - this.fps) * 0.05;

      if (this.dirty && this.mode === 'setup') {
        this.newBattle();
        this.dirty = false;
        if (this.needFit) { this.fit(); this.needFit = false; }
      }

      const B = this.battle;
      if (this.mode === 'battle' && !this.paused) {
        // the moment the battle is decided plays in slow motion for a second and a half
        if (B.endTime && !this.endSeen) { this.endSeen = true; this.slowT = 1.5; }
        const slow = this.slowT <= 0 ? 1 : this.slowT > 0.4 ? 0.4 : 1 - 0.6 * this.slowT / 0.4;
        if (this.slowT > 0) this.slowT -= dtReal;
        this.acc += dtReal * this.speed * slow;
        let steps = 0;
        const t0 = performance.now();
        const maxSteps = Math.max(C.MAX_STEPS_PER_FRAME, Math.ceil(this.speed * 2));
        while (this.acc >= C.DT && steps < maxSteps) {
          B.step(C.DT);
          this.acc -= C.DT;
          steps++;
        }
        if (steps >= maxSteps) this.acc = 0; // can't keep up: slow down instead of spiralling
        if (steps) this.record(B);
        this.stepMs += (performance.now() - t0 - this.stepMs) * 0.1;
        this.fx.decayShake(dtReal);
      }

      this.keyboardPan(dtReal);
      this.cam.update(dtReal, B, this.renderer.vw, this.renderer.vh);
      this.renderer.render(B, this.fx, this.cam, this.hover, this.cam.follow);
      TM.UI.drawMinimap(B, this.cam, this.renderer);
      TM.UI.updateHud(B);
      TM.Audio.frame(dtReal, this.speed, this.cam, this.renderer.vw, this.renderer.vh, this.mode === 'battle' && !this.paused && B.state === 'running', B);

      if (B.state === 'over' && !this.resultShown) {
        this.resultShown = true;
        this.record(B, true);
        TM.UI.showResult(B);
      }
      requestAnimationFrame((t) => this.frame(t));
    },

    // the course of the battle for the result chart: soldiers in the ranks of each army, twice a second
    record(B, final) {
      let h = this.hist;
      if (!h || h.B !== B) h = this.hist = { B, t: [], a: [[], []], next: 0 };
      const t = B.endTime ? Math.min(B.time, B.endTime) : B.time;   // the chart ends with the battle
      if (h.t.length && h.t[h.t.length - 1] >= t) return;
      if (!final && t < h.next && t !== B.endTime) return;
      h.next = t + 0.5;
      h.t.push(t);
      for (let t = 0; t < 2; t++) h.a[t].push(B.stats[t].alive - B.stats[t].fleeing);
    },

    keyboardPan(dt) {
      const k = this.keys;
      let dx = 0, dy = 0;
      if (k.KeyA || k.ArrowLeft) dx += 1;
      if (k.KeyD || k.ArrowRight) dx -= 1;
      if (k.KeyW || k.ArrowUp) dy += 1;
      if (k.KeyS || k.ArrowDown) dy -= 1;
      if (dx || dy) {
        this.cam.auto = false;
        this.cam.follow = null;
        this.cam.pan(dx * 700 * dt, dy * 700 * dt);
        TM.UI.syncControls();
      }
    },

    // ---------------- input ----------------
    bindInput() {
      const cv = document.getElementById('view');
      const R = this.renderer;
      let down = null, dragging = false;

      window.addEventListener('resize', () => { R.resize(); this.cam.dpr = R.dpr; });

      const worldAt = (e) => {
        const rect = cv.getBoundingClientRect();
        return this.cam.toWorld(e.clientX - rect.left, e.clientY - rect.top, R.vw, R.vh);
      };
      cv.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (this.mode === 'setup') TM.Editor.rightClick(worldAt(e));
      });
      cv.addEventListener('mousedown', (e) => {
        down = { x: e.clientX, y: e.clientY, button: e.button };
        dragging = false;
        // setup: grabbing a hand-placed group starts dragging it instead of panning the camera
        if (this.mode === 'setup' && e.button === 0 && TM.Editor.down(worldAt(e))) down.edit = true;
      });
      window.addEventListener('mousemove', (e) => {
        if (down && down.edit) { TM.Editor.dragTo(worldAt(e)); TM.UI.showTooltip(null); return; }
        if (down) {
          const dx = e.clientX - down.x, dy = e.clientY - down.y;
          if (!dragging && Math.hypot(dx, dy) > 4) {
            dragging = true;
            cv.classList.add('dragging');
            this.cam.auto = false;
            this.cam.follow = null;
            TM.UI.syncControls();
          }
          if (dragging) {
            this.cam.pan(e.movementX, e.movementY);
            TM.UI.showTooltip(null);
            return;
          }
        }
        if (e.target !== cv) { this.hover = null; TM.UI.showTooltip(null); TM.Editor.ghost = null; return; }
        const w = worldAt(e);
        if (this.mode === 'setup') {
          TM.Editor.hoverAt(w);
          if (TM.Editor.armed >= 0 || TM.Editor.hover) { this.hover = null; TM.UI.showTooltip(null); return; }
        }
        // sprites stand "up" from their feet in the 3/4 view: probe slightly below the cursor
        const z = this.cam.view();
        this.hover = this.battle.unitAt(w.x, w.y + 6, Math.max(5, 9 / z));
        cv.classList.toggle('over-unit', !!this.hover);
        TM.UI.showTooltip(this.hover, e.clientX, e.clientY);
      });
      window.addEventListener('mouseup', (e) => {
        if (down && down.edit) TM.Editor.up();
        else if (down && !dragging && down.button === 0 && this.mode === 'setup') { if (e.target === cv) TM.Editor.click(worldAt(e)); }
        else if (down && !dragging && down.button === 0) {
          this.cam.follow = this.hover || null;
          if (this.cam.follow) { this.cam.auto = false; this.cam.followReg = null; }
          TM.UI.syncControls();
        }
        down = null;
        dragging = false;
        cv.classList.remove('dragging');
      });
      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = cv.getBoundingClientRect();
        this.cam.auto = false;
        this.cam.wheel(e.deltaY, e.clientX - rect.left, e.clientY - rect.top, R.vw, R.vh);
        TM.UI.syncControls();
      }, { passive: false });

      window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' && e.target.type === 'number')) return;
        if (this.mode === 'setup' && TM.Editor.key(e)) { e.preventDefault(); return; }
        this.keys[e.code] = true;
        const code = e.code;
        if (code === 'Space') { e.preventDefault(); if (this.mode === 'setup') this.start(); else this.togglePause(); }
        else if (code === 'Enter' && this.mode === 'setup') this.start();
        else if (code === 'Escape') {
          if (TM.UI.helpVisible()) TM.UI.toggleHelp();
          else if (this.mode === 'battle') this.toSetup();
        }
        else if (code === 'KeyR' && this.mode === 'battle') this.restart();
        else if (code === 'KeyF') this.fit();
        else if (code === 'KeyC' && this.mode === 'battle') this.toggleAuto();
        else if (code === 'KeyH') TM.UI.toggleHelp();
        else if (code === 'KeyM') TM.Audio.toggleMute();
        else if (code === 'KeyT') this.toggleTactics();
        else if (code === 'KeyN') TM.UI.toggleMinimap();
        else if (code === 'Equal' || code === 'NumpadAdd') { this.cam.auto = false; this.cam.stepZoom(1, R.vw / 2, R.vh / 2, R.vw, R.vh); }
        else if (code === 'Minus' || code === 'NumpadSubtract') { this.cam.auto = false; this.cam.stepZoom(-1, R.vw / 2, R.vh / 2, R.vw, R.vh); }
        else if (/^Digit[1-4]$/.test(code)) this.setSpeed([1, 2, 4, 8][+code.slice(5) - 1]);
        else if (code === 'BracketLeft' || code === 'BracketRight') {
          const list = TM.UI.SPEEDS, i = list.indexOf(this.speed);
          this.setSpeed(list[Math.max(0, Math.min(list.length - 1, i + (code === 'BracketRight' ? 1 : -1)))]);
        }
      });
      window.addEventListener('keyup', (e) => { this.keys[e.code] = false; });
      window.addEventListener('blur', () => { this.keys = {}; });
    },

    // ?preset=N&start=1&skip=SECONDS&zoom=Z&x=&y=  — handy for testing / screenshots
    debugParams() {
      const q = new URLSearchParams(location.search);
      if (q.has('preset')) this.applyPreset(TM.PRESETS[+q.get('preset')] || TM.PRESETS[0]);
      if (q.has('mult')) {
        for (const a of this.setup.armies) for (const k of TM.UNIT_ORDER) a.counts[k] = Math.min(TM.UNIT_TYPES[k].max, Math.round(a.counts[k] * +q.get('mult')));
        TM.UI.syncFromSetup();
      }
      if (q.has('seed')) this.setup.seed = +q.get('seed');
      if (q.get('start') === '1') {
        this.newBattle(); this.dirty = false;
        this.start();
        const skip = +q.get('skip') || 0;
        for (let t = 0; t < skip && this.battle.state !== 'over'; t += C.DT) this.battle.step(C.DT);
        if (skip) { document.getElementById('banner').className = ''; TM.UI.feedSeen = this.battle.events.length; }
        if (q.has('speed')) this.setSpeed(+q.get('speed'));
      }
      if (q.has('zoom')) { this.cam.stop(); this.cam.zoom = +q.get('zoom'); this.cam.auto = false; }
      if (q.has('x')) this.cam.x = +q.get('x');
      if (q.has('y')) this.cam.y = +q.get('y');
      if (q.has('follow')) {
        // e.g. follow=archer or follow=archer:1 (team) — centre camera on such a unit
        const [type, team] = q.get('follow').split(':');
        const u = this.battle.units.find((x) => x.type === type && x.state === 0 && (team == null || x.team === +team));
        if (u) { this.cam.x = u.x; this.cam.y = u.y; this.cam.auto = false; }
      }
      if (q.get('tac') === '1') this.renderer.showTactics = true;
      if (q.get('auto') === '1') { this.cam.auto = true; TM.UI.syncControls(); }
      if (q.get('pause') === '1') { this.paused = true; TM.UI.syncControls(); }
      delete this.setup.seed;
      if (q.get('bench') === '1') TM.Sprites.bitmapsReady.then(() => { this.bench(); this.bench(); });
    },

    // Measures simulation and render cost; result goes into <body data-bench>.
    bench() {
      const B = this.battle, R = this.renderer;
      const t0 = performance.now();
      for (let i = 0; i < 120; i++) B.step(C.DT);
      R.ctx.getImageData(0, 0, 1, 1);
      const t1 = performance.now();
      for (let i = 0; i < 30; i++) R.render(B, this.fx, this.cam, null, null);
      const tj = performance.now();
      R.ctx.getImageData(0, 0, 1, 1);
      const t2 = performance.now();
      const saved = B.units, savedArrows = B.arrows;
      B.units = []; B.arrows = []; R.lastB = null;
      for (let i = 0; i < 30; i++) R.render(B, this.fx, this.cam, null, null);
      R.ctx.getImageData(0, 0, 1, 1);
      const t3 = performance.now();
      B.units = saved; B.arrows = savedArrows; R.lastB = null;
      const res = `units=${B.stats[0].alive + B.stats[1].alive} step=${((t1 - t0) / 120).toFixed(2)}ms render=${((t2 - t1) / 30).toFixed(2)}ms (js ${((tj - t1) / 30).toFixed(2)}ms) groundOnly=${((t3 - t2) / 30).toFixed(2)}ms zoom=${this.cam.zoom.toFixed(2)}`;
      document.body.dataset.bench = (document.body.dataset.bench || '') + ' | ' + res;
      console.log('BENCH', res);
    },
  };

  window.addEventListener('DOMContentLoaded', () => Game.init());
  TM.Game = Game;
})(window.TM = window.TM || {});
