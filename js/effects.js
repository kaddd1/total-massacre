// Visual effects: particles, impact flashes, floating text, screen shake and the
// persistent pixel-art ground layer (1 px = 1 world unit) where blood, arrows and
// corpses are baked in (zero per-frame cost, unlimited bodies).
(function (TM) {
  'use strict';
  // Visual randomness must NOT consume the seeded simulation RNG,
  // otherwise cosmetic changes would alter battle outcomes.
  const R = Math.random;
  const gauss = () => (R() + R() + R() - 1.5) * 0.8165;

  const P_BLOOD = 0, P_SPARK = 1, P_DUST = 2, P_SPLINTER = 3, P_BREATH = 4;

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

  // ---------------------------------------------------------------- pixel-art ground
  function paintGround(ctx, W, H) {
    const seed = (R() * 100000) | 0;
    function hash(x, y) {
      let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }
    function vnoise(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
    const grass = ['#34452a', '#3c4f2c', '#445a30', '#4d6534', '#58713a'].map(hexRgb);
    const dirt = ['#45382a', '#514230', '#5e4d37', '#6b5a41'].map(hexRgb);
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16 - 0.47);

    // low-frequency fields on a coarse grid, bilinear per pixel (fast)
    const G = 8, gw = Math.ceil(W / G) + 2, gh = Math.ceil(H / G) + 2;
    const fA = new Float32Array(gw * gh), fB = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x = i * G, y = j * G;
      fA[j * gw + i] = vnoise(x / 120, y / 120) * 0.62 + vnoise(x / 40 + 17, y / 40 + 5) * 0.38;
      const dx = (x - W / 2) / (W * 0.33), dy = (y - H / 2) / (H * 0.4);
      fB[j * gw + i] = vnoise(x / 75 + 40, y / 75 + 40) * 0.55 + Math.max(0, 1 - (dx * dx + dy * dy)) * 0.5;
    }
    const img = ctx.createImageData(W, H), d = img.data;
    for (let y = 0; y < H; y++) {
      const gj = y / G, j0 = gj | 0, fy = gj - j0;
      for (let x = 0; x < W; x++) {
        const gi = x / G, i0 = gi | 0, fx = gi - i0;
        const o = j0 * gw + i0;
        const a = fA[o] + (fA[o + 1] - fA[o]) * fx, b = fA[o + gw] + (fA[o + gw + 1] - fA[o + gw]) * fx;
        const c = fB[o] + (fB[o + 1] - fB[o]) * fx, e = fB[o + gw] + (fB[o + gw + 1] - fB[o + gw]) * fx;
        const gval = a + (b - a) * fy, dval = c + (e - c) * fy;
        const bz = bayer[(y & 3) * 4 + (x & 3)];
        const grain = hash(x, y) * 0.16 - 0.08;
        let col;
        if (dval + bz * 0.12 + grain * 0.5 > 0.84) col = dirt[Math.max(0, Math.min(3, Math.floor(1.5 + (gval - 0.5) * 2.4 + bz * 1.1 + grain * 4)))];
        else col = grass[Math.max(0, Math.min(4, Math.floor(2 + (gval - 0.5) * 3.0 + bz * 1.15 + grain * 5)))];
        const p = (y * W + x) * 4;
        d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; d[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const px = (x, y, col) => { ctx.fillStyle = col; ctx.fillRect(x, y, 1, 1); };
    // grass tufts
    for (let i = 0; i < 9000; i++) {
      const x = (R() * W) | 0, y = (R() * H) | 0;
      const light = R() < 0.6;
      const col = light ? '#64804a' : '#2b3a20';
      px(x - 1, y - 1, col); px(x + 1, y - 1, col); px(x, y, col);
      if (R() < 0.5) px(x, y - 2, col);
      if (light) px(x, y + 1, '#2e3d22');
    }
    // flowers
    const fl = ['#e8d36a', '#f1efe2', '#c99ad8', '#e48a5a'];
    for (let i = 0; i < 700; i++) {
      const x = (R() * W) | 0, y = (R() * H) | 0;
      px(x, y, fl[i % fl.length]); px(x, y + 1, '#2b3a20');
    }
    // pebbles & rocks with outline and highlight
    for (let i = 0; i < 260; i++) {
      const x = (R() * W) | 0, y = (R() * H) | 0;
      const r = i < 60 ? 2 + ((R() * 3) | 0) : 1;
      for (let yy = -r - 1; yy <= r + 1; yy++) for (let xx = -r - 1; xx <= r + 1; xx++) {
        const q = (xx * xx) / ((r + 0.6) * (r + 0.6)) + (yy * yy) / ((r * 0.75 + 0.6) * (r * 0.75 + 0.6));
        if (q > 1.6) continue;
        let col = q > 1 ? '#1d1a12' : (xx < 0 && yy < 0 ? '#a7a291' : '#7d796b');
        if (q <= 1 && xx + yy > r * 0.6) col = '#5f5b50';
        px(x + xx, y + yy, col);
      }
      if (r > 1) px(x - 1, y - 1, '#c9c4b1');
    }
    // dark map border
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, 3); ctx.fillRect(0, H - 3, W, 3); ctx.fillRect(0, 0, 3, H); ctx.fillRect(W - 3, 0, 3, H);
  }

  class Effects {
    constructor() {
      const C = TM.CONFIG;
      this.W = C.WORLD_W; this.H = C.WORLD_H; this.S = 1;
      this.clean = makeCanvas(this.W, this.H);
      paintGround(this.clean.getContext('2d'), this.W, this.H);
      this.ground = makeCanvas(this.W, this.H);
      this.g = this.ground.getContext('2d');
      this.g.imageSmoothingEnabled = false;

      const M = C.MAX_PARTICLES;
      this.max = M;
      this.px = new Float32Array(M); this.py = new Float32Array(M); this.pz = new Float32Array(M);
      this.vx = new Float32Array(M); this.vy = new Float32Array(M); this.vz = new Float32Array(M);
      this.life = new Float32Array(M); this.maxLife = new Float32Array(M);
      this.size = new Float32Array(M); this.type = new Uint8Array(M);
      this.n = 0;
      this.texts = [];
      this.impacts = [];
      this.waves = [];     // shock rings spreading over the ground (charges, club blows)
      this.shakeAmt = 0;
      this.reset();
    }

    reset() {
      this.g.globalAlpha = 1;
      this.g.drawImage(this.clean, 0, 0);
      this.n = 0;
      this.texts.length = 0;
      this.impacts.length = 0;
      this.waves.length = 0;
      this.shakeAmt = 0;
    }

    // ---------------------------------------------------------------- particles
    spawn(type, x, y, z, vx, vy, vz, life, size) {
      let i = this.n;
      if (i >= this.max) i = (R() * this.max) | 0; // overwrite random when full
      else this.n++;
      this.type[i] = type;
      this.px[i] = x; this.py[i] = y; this.pz[i] = z;
      this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
    }

    blood(x, y, z, dx, dy, amount, power) {
      const n = Math.min(26, amount | 0);
      for (let k = 0; k < n; k++) {
        const sp = (30 + R() * 110) * power;
        const a = Math.atan2(dy, dx) + gauss() * 0.7;
        this.spawn(P_BLOOD, x, y, z + 7, Math.cos(a) * sp, Math.sin(a) * sp, 40 + R() * 120 * power, 2, 1 + R() * 1.4);
      }
    }

    sparks(x, y, z, n) {
      for (let k = 0; k < n; k++) {
        const a = R() * Math.PI * 2, sp = 60 + R() * 140;
        this.spawn(P_SPARK, x, y, z + 8, Math.cos(a) * sp, Math.sin(a) * sp, 60 + R() * 100, 0.25 + R() * 0.2, 1);
      }
    }

    dust(x, y, n, size) {
      for (let k = 0; k < n; k++) {
        const a = R() * Math.PI * 2, sp = 10 + R() * 40;
        this.spawn(P_DUST, x + gauss() * 3, y + gauss() * 3, 1, Math.cos(a) * sp, Math.sin(a) * sp, 8 + R() * 10, 0.6 + R() * 0.6, size * (0.7 + R() * 0.6));
      }
    }

    // Ambient effects read from the battle state (visual RNG only, never the simulation's):
    // hooves throw up dust behind galloping horses and a charging line raises it at its feet.
    tick(B, dt) {
      const T = B.tac;
      if (!T) return;
      if (this.engB !== B) { this.engB = B; this.engSeen = new Map(); }
      for (const Rg of T.regs) {
        if (Rg.alive === 0) continue;
        // a regiment crashing into the enemy (engaged on at 15 % of its men, off below 5 %)
        // spent men pant: a little puff of breath now and then
        if (Rg.sta < 0.35 && Rg.role !== 'monster') {
          for (const u of Rg.members) {
            if (u.state !== 0 || u.sta > 0.25 || R() > dt * 0.7) continue;
            const hh = u.type === 'knight' ? 15 : 12;
            this.spawn(P_BREATH, u.x + Math.cos(u.facing) * 3, u.y + Math.sin(u.facing) * 2, hh, Math.cos(u.facing) * 8, Math.sin(u.facing) * 5, 7, 0.5, 1);
          }
        }
        const was = this.engSeen.get(Rg) || false;
        const eng = !Rg.routing && (was ? Rg.engaged > 0.05 : Rg.engaged > 0.15);
        if (eng && !was) this.clash(B, Rg);
        this.engSeen.set(Rg, eng);
        const cav = Rg.role === 'cavalry';
        if (!cav && !(Rg.order === 'charge' && Rg.speed > 0)) continue;
        for (const u of Rg.members) {
          if (u.state !== 0 || u.z > 0.5) continue;
          const sp = Math.hypot(u.vx, u.vy);
          if (cav) {
            if (sp < 40 || R() > dt * 4.5 * sp / u.def.speed) continue;
            const ix = u.vx / sp, iy = u.vy / sp;
            this.spawn(P_DUST, u.x - ix * 8 + gauss() * 3, u.y - iy * 6 + gauss() * 2 + 1, 1,
              -ix * 14 + gauss() * 9, -iy * 10 + gauss() * 6, 6 + R() * 10, 0.55 + R() * 0.55, 2.8 + R() * 2.5);
          } else {
            if (sp < 28 || R() > dt * 0.6) continue;
            this.spawn(P_DUST, u.x + gauss() * 2, u.y + 2, 1, gauss() * 8, gauss() * 5, 4 + R() * 6, 0.45 + R() * 0.4, 1.8 + R() * 1.5);
          }
        }
      }
    }

    // a lance breaking on a planted pike: splinters of wood
    splinters(x, y, z, n) {
      for (let k = 0; k < n; k++) {
        const a = R() * Math.PI * 2, sp = 40 + R() * 90;
        this.spawn(P_SPLINTER, x, y, z + 10, Math.cos(a) * sp, Math.sin(a) * sp, 80 + R() * 110, 0.6, 1);
      }
    }

    // a ring of air and dust spreading over the ground from a heavy blow
    shock(x, y, r, strong) {
      if (this.waves.length > 40) this.waves.shift();
      this.waves.push({ x, y, r, t: 0, life: strong ? 0.42 : 0.3, strong: !!strong });
    }

    // the ground cracked by a giant's club (baked into the field)
    crack(x, y) {
      const g = this.g;
      g.globalAlpha = 0.55;
      g.fillStyle = '#2a2016';
      for (let k = 0; k < 5; k++) {
        let a = R() * Math.PI * 2, px = x, py = y;
        const len = 5 + R() * 7;
        for (let i = 0; i < len; i++) {
          a += (R() - 0.5) * 0.7;
          px += Math.cos(a); py += Math.sin(a) * 0.6;
          g.fillRect(Math.round(px), Math.round(py), 1, 1);
        }
      }
      g.globalAlpha = 1;
    }

    // the lines meet: a burst of dust and sparks where the men of the regiment came to blows
    clash(B, Rg) {
      let k = 0;
      for (const u of Rg.members) {
        if (u.state !== 0 || u.fleeing || B.time - u.contactT > 0.4) continue;
        if (++k > 26) break;
        const t = u.target && u.target.state === 0 ? u.target : null;
        const x = t ? (u.x + t.x) / 2 : u.x, y = t ? (u.y + t.y) / 2 : u.y;
        this.spawn(P_DUST, x + gauss() * 3, y + gauss() * 2 + 1, 1, gauss() * 16, gauss() * 10, 6 + R() * 8, 0.55 + R() * 0.5, 3 + R() * 2.5);
        if (R() < 0.45) this.sparks(x, y, 2, 2);
      }
    }

    // a giant's footfall
    stomp(x, y) {
      for (let k = 0; k < 4; k++) {
        const a = R() * Math.PI * 2;
        this.spawn(P_DUST, x + Math.cos(a) * 6, y + Math.sin(a) * 3 + 2, 1, Math.cos(a) * 22, Math.sin(a) * 12, 5 + R() * 6, 0.5 + R() * 0.4, 3 + R() * 2);
      }
    }

    // Short pixel flash where a blow lands. kind: hit | slash | crit | block
    impact(x, y, z, nx, ny, kind, h) {
      if (this.impacts.length > 260) this.impacts.shift();
      let d = Math.round(Math.atan2(ny, nx) / (Math.PI / 4)) % 8; if (d < 0) d += 8;
      this.impacts.push({ x, y, z, h: h || 8, t: 0, kind, dir: d });
    }

    text(x, y, str, color, size) {
      if (this.texts.length > 60) this.texts.shift();
      this.texts.push({ x, y, z: 18, t: 0, life: 0.9, str, color, size: size || 9 });
    }

    shake(amount) {
      this.shakeAmt = Math.min(14, this.shakeAmt + amount);
    }

    update(dt) {
      const G = TM.CONFIG.GRAVITY;
      const decay = Math.exp(-2.5 * dt);
      for (let i = 0; i < this.n; i++) {
        this.life[i] -= dt;
        const t = this.type[i];
        if (t === P_DUST || t === P_BREATH) {   // drifting puffs: no gravity
          this.vx[i] *= decay; this.vy[i] *= decay;
          this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt;
          this.pz[i] += this.vz[i] * dt;
          this.size[i] += dt * 6;
        } else {
          this.vz[i] -= G * dt;
          this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
          if (this.pz[i] <= 0) {
            if (t === P_BLOOD) this.stampBloodDrop(this.px[i], this.py[i], this.size[i]);
            else if (t === P_SPLINTER && R() < 0.5) { this.g.fillStyle = '#5a3c1e'; this.g.fillRect(Math.round(this.px[i]), Math.round(this.py[i]), 1, 1); }
            this.life[i] = 0;
          }
        }
        if (this.life[i] <= 0) {
          const last = --this.n;
          if (i !== last) {
            this.type[i] = this.type[last];
            this.px[i] = this.px[last]; this.py[i] = this.py[last]; this.pz[i] = this.pz[last];
            this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last]; this.vz[i] = this.vz[last];
            this.life[i] = this.life[last]; this.maxLife[i] = this.maxLife[last]; this.size[i] = this.size[last];
          }
          i--;
        }
      }
      for (let i = this.texts.length - 1; i >= 0; i--) {
        const tx = this.texts[i];
        tx.t += dt; tx.z += dt * 22;
        if (tx.t >= tx.life) this.texts.splice(i, 1);
      }
      let wv = 0;
      for (let i = 0; i < this.waves.length; i++) {
        const e = this.waves[i];
        e.t += dt;
        if (e.t < e.life) this.waves[wv++] = e;
      }
      this.waves.length = wv;
      let w = 0;
      for (let i = 0; i < this.impacts.length; i++) {
        const e = this.impacts[i];
        e.t += dt;
        if (e.t < 0.18) this.impacts[w++] = e;
      }
      this.impacts.length = w;
    }

    decayShake(dt) {
      this.shakeAmt *= Math.exp(-7 * dt);
      if (this.shakeAmt < 0.05) this.shakeAmt = 0;
    }

    // ---------------------------------------------------------------- baked decals (pixel style)
    stampBloodDrop(x, y, s) {
      if (R() < 0.6) return;
      const g = this.g;
      g.globalAlpha = 0.8;
      g.fillStyle = R() < 0.5 ? '#5c0b09' : '#7a120e';
      const xi = Math.round(x), yi = Math.round(y);
      g.fillRect(xi, yi, 1, 1);
      if (s > 1.9) g.fillRect(xi + 1, yi, 1, 1);
      g.globalAlpha = 1;
    }

    // irregular pixel pool: dark rim, wetter core
    stampBlood(x, y, r) {
      const g = this.g;
      const n = Math.round(r * r * 1.7);
      const cx = Math.round(x), cy = Math.round(y);
      g.globalAlpha = 0.8;
      for (let i = 0; i < n; i++) {
        const dx = Math.round(gauss() * r * 0.55), dy = Math.round(gauss() * r * 0.4);
        const q = (dx * dx) / (r * r) + (dy * dy) / (r * r * 0.5);
        g.fillStyle = q < 0.25 ? '#7e130f' : q < 0.6 ? '#62100c' : '#4a0b08';
        g.fillRect(cx + dx, cy + dy, 1, 1);
      }
      g.globalAlpha = 1;
    }

    stampArrow(x, y, ang) {
      let d = Math.round(ang / (Math.PI / 4)) % 8; if (d < 0) d += 8;
      this.g.drawImage(TM.Sprites.stuck[d], Math.round(x) - 4, Math.round(y) - 4);
    }

    trample(x, y, r) {
      const g = this.g;
      g.globalAlpha = 0.16;
      g.fillStyle = '#35291a';
      for (let i = 0; i < 3; i++) g.fillRect(Math.round(x + gauss() * r * 0.5), Math.round(y + gauss() * r * 0.35), 1, 1);
      g.globalAlpha = 1;
    }

    stampCorpse(u) {
      this.stampBlood(u.x, u.y + 1, u.r * 1.15);
      TM.Sprites.stampCorpse(this.g, u);
    }

  }

  Effects.P_BLOOD = P_BLOOD; Effects.P_SPARK = P_SPARK; Effects.P_DUST = P_DUST; Effects.P_SPLINTER = P_SPLINTER;
  TM.Effects = Effects;
})(window.TM = window.TM || {});
