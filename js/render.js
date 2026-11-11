// Pixel-art renderer.
//
// Everything is drawn in device pixels on an "art pixel" grid:
//   D = device pixels per world unit (camera zoom × devicePixelRatio).
//   D >= 1 : sprites at 1 art px = 1 world unit, upscaled by integer n = D
//            (the camera snaps to integer levels in this range -> crisp pixels).
//   D <  1 : natively generated smaller sprite sets (0.66 / 0.4 / 0.25 art px per
//            world unit) drawn 1:1 — far zoom stays crisp and readable instead of
//            becoming a blurry downscale.
// Units are depth-sorted by ground y (3/4 view: nearer units overlap farther ones).
(function (TM) {
  'use strict';
  const { ALIVE, DYING } = TM.Units;

  // ---------------------------------------------------------------- animation choice
  // Visual-only state machine: reads simulation state, never writes it.
  let A = 'idle', F = 0;
  function choose(u) {
    if (u.state === DYING) { A = 'death'; F = u.deathT < 0.12 ? 0 : u.deathT < 0.26 ? 1 : 2; return; }
    if (u.z > 2) { A = 'death'; F = u.vz > 0 ? 0 : 1; return; } // knocked into the air: tumbling
    const t = u.type;
    const moving = u.moveAmt > 0.15;
    const wf = ((Math.floor(u.walk / (Math.PI / 2)) % 4) + 4) % 4;
    if (u.fleeing && t !== 'knight' && t !== 'giant') { A = 'flee'; F = wf; return; }
    if (u.atkT >= 0) {
      const w = u.def.windup;
      A = 'attack'; F = u.atkT < w ? 0 : u.atkT < w + 0.09 ? 1 : 2;
      return;
    }
    const tg = u.target && u.target.state === ALIVE ? u.target : null;
    if (t === 'archer') {
      if (u.shotT < 0.2) { A = 'release'; F = 0; return; }
      if (tg && !moving && u.rangedCd < 1.1 && Math.hypot(tg.x - u.x, tg.y - u.y) <= u.def.ranged.range + 30) { A = 'aim'; F = 0; return; }
    } else if (t === 'spear') {
      if (tg && Math.abs(tg.x - u.x) + Math.abs(tg.y - u.y) < 130) { A = moving ? 'walkReady' : 'ready'; F = moving ? wf : 0; return; }
    } else if (t === 'knight') {
      if (tg && u.mode === 0) { A = moving ? 'charge' : 'ready'; F = moving ? wf : 0; return; }
    }
    if (moving) { A = 'walk'; F = wf; } else { A = 'idle'; F = 0; }
  }

  const BLOOD = ['#7a0f0c', '#a3170f', '#5c0a08'];

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = 1; this.vw = 1; this.vh = 1;
      this.order = []; this.lastB = null;
      this.vis = []; this.visFr = [];
      this.resize();
    }

    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.vw = Math.max(1, r.width); this.vh = Math.max(1, r.height);
      this.canvas.width = Math.round(this.vw * this.dpr);
      this.canvas.height = Math.round(this.vh * this.dpr);
    }

    // y-sorted unit order, maintained incrementally (insertion sort on a nearly sorted list)
    sortUnits(B) {
      if (B !== this.lastB) { this.order = B.units.slice().sort((a, b) => a.y - b.y); this.lastB = B; }
      const o = this.order;
      for (let i = 1; i < o.length; i++) {
        const u = o[i], y = u.y;
        let j = i - 1;
        if (o[j].y <= y) continue;
        while (j >= 0 && o[j].y > y) { o[j + 1] = o[j]; j--; }
        o[j + 1] = u;
      }
      return o;
    }

    render(B, fx, cam, hover, follow) {
      const S = TM.Sprites, K = S.K;
      const ctx = this.ctx, cw = this.canvas.width, ch = this.canvas.height;
      cam.dpr = this.dpr;
      const D = cam.view() * this.dpr;
      let n, si;
      if (D >= 0.999) { n = Math.max(1, Math.round(D)); si = 0; }
      else { n = 1; si = D >= 0.8 ? 0 : D >= 0.52 ? 1 : D >= 0.32 ? 2 : 3; }
      this.n = n; this.si = si; this.D = D;
      const set = S.sets[si], nd = set.nd;
      const Wd = TM.CONFIG.WORLD_W, Hd = TM.CONFIG.WORLD_H;

      const sh = fx.shakeAmt;
      const shx = sh ? Math.round((Math.random() - 0.5) * sh * this.dpr / n) * n : 0;
      const shy = sh ? Math.round((Math.random() - 0.5) * sh * this.dpr / n) * n : 0;
      const ox = Math.round(cw / 2 - cam.x * D) + shx, oy = Math.round(ch / 2 - cam.y * D) + shy;
      this.ox = ox; this.oy = oy;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#15130e';
      ctx.fillRect(0, 0, cw, ch);

      // visible world rect
      const vx0 = -ox / D, vy0 = -oy / D, vx1 = (cw - ox) / D, vy1 = (ch - oy) / D;

      // ground with baked corpses / blood / arrows
      const gx0 = Math.max(0, Math.floor(vx0)), gy0 = Math.max(0, Math.floor(vy0));
      const gx1 = Math.min(Wd, Math.ceil(vx1)), gy1 = Math.min(Hd, Math.ceil(vy1));
      if (gx1 > gx0 && gy1 > gy0) {
        ctx.imageSmoothingEnabled = D < 0.999;
        ctx.drawImage(fx.ground, gx0, gy0, gx1 - gx0, gy1 - gy0, gx0 * D + ox, gy0 * D + oy, (gx1 - gx0) * D, (gy1 - gy0) * D);
      }
      ctx.imageSmoothingEnabled = false;

      // collect visible units in depth order + their frames
      const m = 60;
      const cx0 = vx0 - m, cy0 = vy0 - m, cx1 = vx1 + m, cy1 = vy1 + m * 1.6;
      const order = this.sortUnits(B);
      const vis = this.vis, visFr = this.visFr;
      let nv = 0;
      for (let i = 0; i < order.length; i++) {
        const u = order[i];
        if (u.state > DYING || u.x < cx0 || u.x > cx1 || u.y < cy0 || u.y > cy1) continue;
        choose(u);
        const ang = u.state === DYING ? u.facing + u.deathRot * 0.5 : u.facing;
        const byDir = set.meta[u.type][A];
        vis[nv] = u;
        visFr[nv] = byDir[S.dirIndex(ang, nd)][F];
        nv++;
      }

      // cast shadows as a separate ground layer at close zoom (smaller sets have them baked in)
      if (si === 0) {
        ctx.globalAlpha = 0.3;
        for (let i = 0; i < nv; i++) {
          const u = vis[i], fr = visFr[i].shadow;
          if (!fr) continue;
          const px = Math.round(u.x * D + ox), py = Math.round(u.y * D + oy);
          ctx.drawImage(set.shadow, fr.x, fr.y, fr.w, fr.h, px - fr.ax * n, py - fr.ay * n, fr.w * n, fr.h * n);
        }
        ctx.globalAlpha = 1;
      }
      this.drawArrowShadows(ctx, B.arrows, D, ox, oy, n, vx0, vy0, vx1, vy1);
      this.drawRing(ctx, hover, '#f4efe2', D, ox, oy, n);
      this.drawRing(ctx, follow, '#ffd34d', D, ox, oy, n);

      // units
      for (let i = 0; i < nv; i++) {
        const u = vis[i], fr = visFr[i].body;
        const px = Math.round(u.x * D + ox), py = Math.round((u.y - u.z * K) * D + oy);
        const dx = px - fr.ax * n, dy = py - fr.ay * n, dw = fr.w * n, dh = fr.h * n;
        ctx.drawImage(set.color[u.team], fr.x, fr.y, fr.w, fr.h, dx, dy, dw, dh);
        if (u.hitFlash > 0 && u.state === ALIVE && si <= 1) {
          // hit flash: white silhouette fading out over the normal sprite
          ctx.globalAlpha = Math.min(1, u.hitFlash / 0.12) * 0.75;
          ctx.drawImage(set.flash, fr.x, fr.y, fr.w, fr.h, dx, dy, dw, dh);
          ctx.globalAlpha = 1;
        }
      }

      this.drawArrows(ctx, B.arrows, D, ox, oy, n, si, K, vx0, vy0, vx1, vy1);
      this.drawParticles(ctx, fx, D, ox, oy, n, K, vx0, vy0, vx1, vy1);
      this.drawImpacts(ctx, fx, D, ox, oy, n, K);
      this.drawOverlays(ctx, nv, D, ox, oy, n, K, follow);
      this.drawTexts(ctx, fx, D, ox, oy, n, K);

      if (TM.Game && TM.Game.mode === 'setup') TM.Editor.draw(ctx, D, ox, oy, n);

      // world border
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(2, n);
      ctx.strokeRect(ox, oy, Wd * D, Hd * D);
    }

    drawRing(ctx, u, col, D, ox, oy, n) {
      if (!u || u.state !== ALIVE) return;
      const r = Math.max(2, Math.round(u.r * Math.min(1, D) * (u.type === 'knight' ? 1.3 : 1)));
      const cv = TM.Sprites.ring(r, col);
      const px = Math.round(u.x * D + ox), py = Math.round(u.y * D + oy);
      ctx.drawImage(cv, px - Math.floor(cv.width / 2) * n, py - Math.floor(cv.height / 2) * n, cv.width * n, cv.height * n);
    }

    drawArrowShadows(ctx, arrows, D, ox, oy, n, vx0, vy0, vx1, vy1) {
      if (!arrows.length) return;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      const w = D < 0.999 ? 1 : 2 * n;
      for (let i = 0; i < arrows.length; i++) {
        const p = arrows[i];
        if (p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue;
        ctx.fillRect(Math.round(p.x * D + ox), Math.round(p.y * D + oy), w, n);
      }
    }

    drawArrows(ctx, arrows, D, ox, oy, n, si, K, vx0, vy0, vx1, vy1) {
      if (!arrows.length) return;
      const spr = TM.Sprites.arrows[si];
      for (let i = 0; i < arrows.length; i++) {
        const p = arrows[i];
        if (p.x < vx0 || p.x > vx1 || p.y < vy0 - 100 || p.y > vy1 + 100) continue;
        const s = p.s || 0;
        const vz = -6 + 4 * p.h * (1 - 2 * s);
        const a = Math.atan2((p.ty - p.y0) - vz * K, p.tx - p.x0);
        let d = Math.round(a / (Math.PI / 8)) % 16; if (d < 0) d += 16;
        const cv = spr[d];
        const px = Math.round(p.x * D + ox), py = Math.round((p.y - p.z * K) * D + oy);
        const half = (cv.width - 1) / 2;
        ctx.drawImage(cv, px - half * n, py - half * n, cv.width * n, cv.height * n);
      }
    }

    drawParticles(ctx, fx, D, ox, oy, n, K, vx0, vy0, vx1, vy1) {
      const cnt = fx.n;
      if (!cnt) return;
      const { px, py, pz, type, size, life, maxLife } = fx;
      const far = D < 0.999;
      // blood: 3 tones, square art pixels
      for (let tone = 0; tone < 3; tone++) {
        ctx.fillStyle = BLOOD[tone];
        for (let i = tone; i < cnt; i += 3) {
          if (type[i] !== 0) continue;
          const x = px[i], y = py[i];
          if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
          const s = far ? (size[i] > 2 && D > 0.6 ? 2 : 1) : Math.max(1, Math.round(size[i])) * n;
          ctx.fillRect(Math.round(x * D + ox), Math.round((y - pz[i] * K) * D + oy), s, s);
        }
      }
      // sparks
      ctx.fillStyle = '#ffe28a';
      for (let i = 0; i < cnt; i++) {
        if (type[i] !== 1) continue;
        ctx.fillRect(Math.round(px[i] * D + ox), Math.round((py[i] - pz[i] * K) * D + oy), n, n);
      }
      // dust puffs: chunky pixel clouds fading out
      ctx.fillStyle = '#b5a47c';
      for (let i = 0; i < cnt; i++) {
        if (type[i] !== 2) continue;
        const x = px[i], y = py[i];
        if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
        const k = life[i] / maxLife[i];
        ctx.globalAlpha = k * 0.55;
        const s = Math.max(1, Math.round(size[i] * 0.6 * Math.min(1, D))) * (far ? 1 : n);
        ctx.fillRect(Math.round(x * D + ox) - (s >> 1), Math.round((y - pz[i] * K) * D + oy) - (s >> 1), s, s);
      }
      ctx.globalAlpha = 1;
    }

    drawImpacts(ctx, fx, D, ox, oy, n, K) {
      const list = fx.impacts;
      if (!list.length || D < 0.45) return;
      const S = TM.Sprites;
      const k = D >= 0.999 ? n : 1;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const f = Math.min(2, (e.t / 0.06) | 0);
        const cv = e.kind === 'slash' ? S.slash[e.dir][f] : S.impacts[e.kind][f];
        const px = Math.round(e.x * D + ox), py = Math.round((e.y - (e.z + e.h) * K) * D + oy);
        const hw = (cv.width - 1) / 2, hh = (cv.height - 1) / 2;
        ctx.drawImage(cv, px - hw * k, py - hh * k, cv.width * k, cv.height * k);
      }
    }

    drawOverlays(ctx, nv, D, ox, oy, n, K, follow) {
      const S = TM.Sprites, vis = this.vis, visFr = this.visFr;
      const k = D >= 0.999 ? n : 1;
      const smallBars = D >= 5;
      let followTop = null;
      for (let i = 0; i < nv; i++) {
        const u = vis[i];
        if (u.state !== ALIVE) continue;
        const fr = visFr[i].body;
        const px = Math.round(u.x * D + ox), py = Math.round((u.y - u.z * K) * D + oy);
        const top = py - fr.ay * n;
        if (u === follow) followTop = [px, top];
        const hpR = u.hp / u.maxHp;
        const t = u.type;
        if (hpR < 0.999 && (t === 'giant' || t === 'knight' || smallBars)) {
          const wa = t === 'giant' ? 22 : t === 'knight' ? 14 : 10;
          const bx = px - ((wa + 2) >> 1) * k, by = top - 4 * k;
          ctx.fillStyle = '#120c0b'; ctx.fillRect(bx, by, (wa + 2) * k, 3 * k);
          ctx.fillStyle = '#3a1a14'; ctx.fillRect(bx + k, by + k, wa * k, k);
          ctx.fillStyle = hpR > 0.5 ? '#7bd14b' : hpR > 0.25 ? '#e8c23a' : '#e2452f';
          ctx.fillRect(bx + k, by + k, Math.max(1, Math.round(wa * hpR)) * k, k);
        }
        if (u.fleeing && D >= 0.4) {
          const f = S.flag;
          ctx.drawImage(f, px + k, top - (f.height + 1) * k, f.width * k, f.height * k);
        }
      }
      if (followTop) {
        const mk = S.marker;
        const bob = Math.round(Math.sin(performance.now() / 180) * 1.5) * k;
        ctx.drawImage(mk, followTop[0] - 3 * k, followTop[1] - (mk.height + 6) * k + bob, mk.width * k, mk.height * k);
      }
    }

    drawTexts(ctx, fx, D, ox, oy, n, K) {
      if (!fx.texts.length || D < 0.999) return;
      const k = Math.max(1, Math.round(n / 2));
      for (const t of fx.texts) {
        const cv = TM.Sprites.text(t.str, t.color);
        ctx.globalAlpha = Math.min(1, (1 - t.t / t.life) * 2);
        const px = Math.round(t.x * D + ox), py = Math.round((t.y - t.z * K) * D + oy);
        ctx.drawImage(cv, px - ((cv.width * k) >> 1), py - cv.height * k, cv.width * k, cv.height * k);
      }
      ctx.globalAlpha = 1;
    }
  }

  TM.Render = {
    Renderer,
    drawIcon: (canvas, type, team) => TM.Sprites.drawIcon(canvas, type, team),
  };
})(window.TM = window.TM || {});
