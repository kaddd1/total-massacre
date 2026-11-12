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
  let A = 'idle', F = 0, WIN = -1, NOW = 0;
  const HURT = { sword: 1, spear: 1, archer: 1, berserk: 1, crossbow: 1 };
  function choose(u) {
    if (u.state === DYING) { A = 'death'; F = u.deathT < 0.12 ? 0 : u.deathT < 0.26 ? 1 : 2; return; }
    const t = u.type;
    if (u.z > 2) {
      // the winners jump for joy, swords and clubs in the air; anyone else up there was knocked flying
      if (u.team === WIN) { if (t === 'sword' || t === 'giant' || t === 'berserk' || t === 'general') { A = 'attack'; F = 0; } else { A = 'idle'; F = 0; } return; }
      A = 'death'; F = u.vz > 0 ? 0 : 1; return;
    }
    const moving = u.moveAmt > 0.15;
    if (u.fleeing && !u.def.mounted && t !== 'giant') { A = 'flee'; F = ((Math.floor(u.walk / (Math.PI / 2)) % 4) + 4) % 4; return; }
    if (u.atkT >= 0) {
      const w = u.def.windup;
      A = 'attack'; F = u.atkT < w ? 0 : u.atkT < w + 0.09 ? 1 : 2;
      return;
    }
    if (u.hitFlash > 0.03 && HURT[t]) { A = 'hurt'; F = 0; return; } // rocked back by a blow
    if (t === 'sword' && NOW - u.blockT < 0.45) { A = 'block'; F = 0; return; } // an arrow on the shield
    const tg = u.target && u.target.state === ALIVE ? u.target : null;
    // formed infantry in its place in the ranks marches in step with the whole regiment
    let wf = 0;
    if (moving) {
      const R = u.reg;
      let wph = u.walk;
      if (R && R.discipline && R._wph !== undefined && (R.role === 'front' || R.role === 'support' || R.role === 'missile')) {
        const dx = u.x - R.slotX(u), dy = u.y - R.slotY(u);
        if (dx * dx + dy * dy < 100) wph = R._wph;
      }
      wf = ((Math.floor(wph / (Math.PI / 2)) % 4) + 4) % 4;
    }
    if (t === 'crossbow') {
      if (u.shotT < 0.2) { A = 'release'; F = 0; return; }
      if (!moving && u.rangedCd > 1.1 && u.shotT < 6) { A = 'reload'; F = 0; return; }   // spanning the bow again
      if (tg && !moving && Math.hypot(tg.x - u.x, tg.y - u.y) <= u.def.ranged.range + 30) { A = 'aim'; F = 0; return; }
    } else if (t === 'horsearcher') {
      if (u.shotT < 0.2) { A = 'release'; F = 0; return; }
      if (!moving && u.rangedCd < 0.5 && u.ammo > 0 && tg) { A = 'aim'; F = 0; return; }
    } else if (t === 'archer') {
      if (u.shotT < 0.2) { A = 'release'; F = 0; return; }
      if (tg && !moving && u.rangedCd < 1.1 && Math.hypot(tg.x - u.x, tg.y - u.y) <= u.def.ranged.range + 30) { A = 'aim'; F = 0; return; }
    } else if (t === 'spear') {
      // spear levelled at a close enemy, and whenever the regiment plants its pikes or goes in
      const o = u.reg && u.reg.order;
      if ((tg && Math.abs(tg.x - u.x) + Math.abs(tg.y - u.y) < 130) || o === 'brace' || o === 'charge' || o === 'engage') { A = moving ? 'walkReady' : 'ready'; F = moving ? wf : 0; return; }
    } else if (t === 'knight') {
      // lance down at a target, and through the whole charge of the regiment
      const o = u.reg && u.reg.order;
      if ((tg || o === 'approach' || o === 'lance') && u.mode === 0) { A = moving ? 'charge' : 'ready'; F = moving ? wf : 0; return; }
    }
    if (moving) { A = 'walk'; F = wf; } else { A = 'idle'; F = 0; }
  }

  const BLOOD = ['#7a0f0c', '#a3170f', '#5c0a08'];

  // ---------------------------------------------------------------- regiment standards
  // Every formed regiment carries its standard: a soldier of the second rank, centre. If he falls,
  // the nearest man picks it up; when the regiment breaks (or dies) the standard drops to the ground.
  const STD_BASE = { sword: 4, spear: 4, berserk: 4, archer: 4, crossbow: 4, knight: 9, horsearcher: 9, giant: 19, general: 11 }; // hand height, art px
  function pickBearer(R, s) {
    let best = null, bd = Infinity;
    const fresh = !s.bearer, td = R.front - R.spacing * 1.5;
    for (const u of R.members) {
      if (u.state !== ALIVE || u.fleeing) continue;
      const d = fresh ? (u.sdep - td) * (u.sdep - td) + u.slat * u.slat : (u.x - s.x) * (u.x - s.x) + (u.y - s.y) * (u.y - s.y);
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }

  // Map pings of the tactical events (the same ones as in the feed): rings spreading from where a
  // regiment broke, charged a flank, planted its pikes… [colour, radius (world units), seconds]
  const PING = {
    rout: ['#ffb347', 70, 2.6], break: ['#ffb347', 130, 3], rear: ['#ff6a4a', 55, 2.2], flank: [null, 45, 1.8],
    brace: ['#efe9d8', 45, 1.8], reserve: [null, 55, 2], volley: ['#ffd34d', 35, 1.3], rally: ['#8fe060', 50, 2.2],
    genfall: ['#ffd34d', 160, 3.2], marshal: ['#ffd34d', 50, 2], warlord: ['#ff6a4a', 50, 2], quiver: [null, 40, 1.6],
    giant: ['#ffd34d', 80, 2.6], blood: ['#ff6a4a', 35, 1.6], hero: ['#ffffff', 30, 1.6], win: [null, 150, 3.2],
    stand: ['#ffb347', 45, 1.8], giveup: [null, 40, 1.6],
  };

  // a ground ring (seen in the 3/4 view: flattened) stroked one art pixel wide
  function ellipse(ctx, x, y, r, col, k) {
    ctx.strokeStyle = col; ctx.lineWidth = Math.max(1, k);
    ctx.beginPath(); ctx.ellipse(Math.round(x), Math.round(y), r, r * 0.6, 0, 0, Math.PI * 2); ctx.stroke();
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = 1; this.vw = 1; this.vh = 1;
      this.order = []; this.lastB = null;
      this.vis = []; this.visFr = [];
      this.std = new Map(); this.stdB = null; this.bearers = new Map(); this.fallen = [];
      this.resize();
    }

    // visual-only bookkeeping of the standards; returns bearer -> standard
    updateStandards(B, fx) {
      const map = this.bearers;
      map.clear();
      if (B !== this.stdB) { this.stdB = B; this.std = new Map(); this.fallen = []; }
      if (!B.tac) return map;
      for (const R of B.tac.regs) {
        let s = this.std.get(R);
        if (!s) { s = { R, bearer: null, phase: Math.random() * 4, x: R.cx, y: R.cy, up: true, falls: 0 }; this.std.set(R, s); }
        if (R.routing || R.n === 0) {
          if (s.up && s.bearer && (R.routing || R.alive === 0) && s.falls < 2 && B.state !== 'deploy') { this.fallen.push({ x: s.x, y: s.y, team: R.team }); s.falls++; }
          s.up = false; s.bearer = null;
          continue;
        }
        s.up = true;
        let b = s.bearer;
        if (!b || b.state !== ALIVE || b.fleeing || b.reg !== R) b = s.bearer = pickBearer(R, s);
        if (!b) continue;
        s.x = b.x; s.y = b.y;
        map.set(b, s);
      }
      return map;
    }

    // Standards dropped where regiments broke or died: they stay on the field, above the bodies,
    // so after the battle the field shows where each regiment gave way.
    drawFallen(ctx, D, ox, oy, n, vx0, vy0, vx1, vy1) {
      const list = this.fallen;
      if (!list.length) return;
      const S = TM.Sprites, sc = D >= 0.999 ? n : Math.max(0.6, D);
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (f.x < vx0 - 20 || f.x > vx1 + 20 || f.y < vy0 - 20 || f.y > vy1 + 20) continue;
        const cv = S.fallen[f.team];
        ctx.drawImage(cv, Math.round(f.x * D + ox - 9 * sc), Math.round(f.y * D + oy - 6 * sc), Math.round(cv.width * sc), Math.round(cv.height * sc));
      }
    }

    // the standard above its bearer: close up it is part of the scene (art scale, depth-sorted);
    // from medium zoom out it is a marker on top of the crowd (1 device px per art px, dark halo,
    // shorter pole)
    drawStandard(ctx, s, u, px, py, n, si, t) {
      const S = TM.Sprites, BN = S.BANNER, R = s.R;
      const mark = !(si === 0 && n >= 2), pad = mark ? 1 : 0, k = mark ? 1 : n;
      const cv = (mark ? S.bannerMarks : S.banners)[R.team][R.type][((t * 7 + s.phase) | 0) & 3];
      const scale = si === 0 ? n : S.SCALES[si];
      const base = Math.round(STD_BASE[u.type] * scale) + (mark ? 1 : 0);
      const h = BN.H + 2 * pad - (mark ? (si === 0 ? 6 : si === 1 ? 9 : 12) : 0), w = BN.W + 2 * pad;
      const off = mark ? 1 : (u.def.mounted ? 4 : u.type === 'giant' ? 9 : 3) * n;
      ctx.drawImage(cv, 0, 0, w, h, px + off - (BN.AX + pad) * k, py - base - h * k, w * k, h * k);
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
      WIN = B.winner; NOW = B.time;
      // marching step of every regiment (visual-only), advanced by the simulated time since last frame
      const dtB = B === this.stepB ? Math.max(0, B.time - this.stepT) : 0;
      this.stepB = B; this.stepT = B.time;
      if (B.tac) for (const Rg of B.tac.regs) Rg._wph = (Rg._wph || 0) + Math.hypot(Rg.vx, Rg.vy) * dtB * 0.22;
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
      this.drawFallen(ctx, D, ox, oy, n, vx0, vy0, vx1, vy1);
      this.drawArrowShadows(ctx, B.arrows, D, ox, oy, n, vx0, vy0, vx1, vy1);
      this.drawWaves(ctx, fx, D, ox, oy, n);
      // the regiment under the mouse (its chip in the HUD, or one of its soldiers) is outlined
      const fReg = this.focusReg || (hover && hover.reg) || cam.followReg;
      if (fReg && fReg.alive) {
        ctx.globalAlpha = this.focusReg ? 0.9 : fReg === cam.followReg && !hover ? 0.35 : 0.45;
        const col = TM.TEAMS[fReg.team].light;
        for (const u of fReg.members) if (u.state === ALIVE && u.x > cx0 && u.x < cx1 && u.y > cy0 && u.y < cy1) this.drawRing(ctx, u, col, D, ox, oy, n);
        ctx.globalAlpha = 1;
      }
      // the generals stand on a gold ring so the eye finds them in the crowd
      if (B.generals) for (const g of B.generals) if (g && g.state === ALIVE && g.x > cx0 && g.x < cx1 && g.y > cy0 && g.y < cy1) {
        ctx.globalAlpha = 0.8; this.drawRing(ctx, g, '#ffd34d', D, ox, oy, n); ctx.globalAlpha = 1;
      }
      this.drawRing(ctx, hover, '#f4efe2', D, ox, oy, n);
      this.drawRing(ctx, follow, '#ffd34d', D, ox, oy, n);

      // units (close up a standard is drawn right after its bearer, in depth order)
      const bearers = this.updateStandards(B, fx);
      const animT = B.state === 'deploy' ? performance.now() / 1000 : B.time;
      const stdInline = si === 0 && n >= 2 && bearers.size > 0;
      for (let i = 0; i < nv; i++) {
        const u = vis[i], fr = visFr[i].body;
        const px = Math.round(u.x * D + ox), py = Math.round((u.y - u.z * K) * D + oy);
        const dx = px - fr.ax * n, dy = py - fr.ay * n, dw = fr.w * n, dh = fr.h * n;
        ctx.drawImage(set.color[u.team], fr.x, fr.y, fr.w, fr.h, dx, dy, dw, dh);
        if (u.hitFlash > 0 && u.state === ALIVE && si <= 1) {
          // hit flash: white silhouette fading out over the normal sprite
          ctx.globalAlpha = Math.min(1, u.hitFlash / 0.12) * (u.type === 'giant' ? 0.35 : u.def.mounted ? 0.55 : 0.75); // big targets are hit all the time
          ctx.drawImage(set.flash, fr.x, fr.y, fr.w, fr.h, dx, dy, dw, dh);
          ctx.globalAlpha = 1;
        }
        if (stdInline) { const s = bearers.get(u); if (s) this.drawStandard(ctx, s, u, px, py, n, si, animT); }
      }
      if (!stdInline && bearers.size) {
        for (const [u, s] of bearers) {
          if (u.x < cx0 || u.x > cx1 || u.y < cy0 || u.y > cy1) continue;
          this.drawStandard(ctx, s, u, Math.round(u.x * D + ox), Math.round((u.y - u.z * K) * D + oy), n, si, animT);
        }
      }

      this.drawArrows(ctx, B.arrows, D, ox, oy, n, si, K, vx0, vy0, vx1, vy1);
      this.drawParticles(ctx, fx, D, ox, oy, n, K, vx0, vy0, vx1, vy1);
      this.drawImpacts(ctx, fx, D, ox, oy, n, K);
      this.drawPings(ctx, B, D, ox, oy, n);
      this.drawOverlays(ctx, nv, D, ox, oy, n, K, follow);
      this.drawTexts(ctx, fx, D, ox, oy, n, K);

      if (TM.Game && TM.Game.mode === 'setup') TM.Editor.draw(ctx, D, ox, oy, n);
      else if (this.showTactics && B.tac) this.drawTactics(ctx, B, D, ox, oy, n);

      // world border
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(2, n);
      ctx.strokeRect(ox, oy, Wd * D, Hd * D);
    }

    // Tactical overlay (key T), drawn like a staff map: every regiment's footprint (its front edge
    // bold), a dashed arrow where it is marching, an arrow to the enemy it charges or shoots at, and a
    // label with its order under it. Routing regiments get an orange marker where the runners are.
    drawTactics(ctx, B, D, ox, oy, n) {
      const k = D >= 0.999 ? Math.max(1, Math.round(n / 2)) : 1;
      const ON = TM.Tactics.ORDER_NAME, S = TM.Sprites;
      const sx = (x) => x * D + ox, sy = (y) => y * D + oy;
      const arrow = (x0, y0, x1, y1, col, w, dash, head) => {
        const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy);
        if (l < 4) return;
        const ux = dx / l, uy = dy / l, hs = head * k;
        ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = w;
        ctx.setLineDash(dash ? [5 * k, 4 * k] : []);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * hs * 0.8, y1 - uy * hs * 0.8); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ux * hs - uy * hs * 0.55, y1 - uy * hs + ux * hs * 0.55);
        ctx.lineTo(x1 - ux * hs + uy * hs * 0.55, y1 - uy * hs - ux * hs * 0.55);
        ctx.closePath(); ctx.fill();
      };
      const labels = [];
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (const R of B.tac.regs) {
        if (R.alive === 0 || (R.n === 0 && !R.routing)) continue;
        const T = TM.TEAMS[R.team];
        if (R.routing || R.n === 0) {
          const x = sx(R.fcx), y = sy(R.fcy), r = 7 * k;
          ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ffb347'; ctx.lineWidth = 2 * k;
          ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
          labels.push({ x, y: y + r + 3 * k, text: `${R.name} ${R.fleeing}: бегут`, col: '#ffb347' });
          continue;
        }
        // footprint: where the regiment's ranks stand
        const c = R.cos, s = R.sin;
        const P = (dep, lat) => [sx(R.ax + c * dep - s * lat), sy(R.ay + s * dep + c * lat)];
        const f0 = P(R.front, -R.halfW), f1 = P(R.front, R.halfW), b1 = P(R.back, R.halfW), b0 = P(R.back, -R.halfW);
        ctx.globalAlpha = 0.07; ctx.fillStyle = T.light;
        ctx.beginPath(); ctx.moveTo(f0[0], f0[1]); ctx.lineTo(f1[0], f1[1]); ctx.lineTo(b1[0], b1[1]); ctx.lineTo(b0[0], b0[1]); ctx.closePath(); ctx.fill();
        ctx.globalAlpha = 0.4; ctx.strokeStyle = T.light; ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5 + k * 0.75;
        ctx.strokeStyle = R.engaged > 0.15 ? '#ff8c80' : T.light;
        ctx.beginPath(); ctx.moveTo(f0[0], f0[1]); ctx.lineTo(f1[0], f1[1]); ctx.stroke();
        const fx = (f0[0] + f1[0]) / 2, fy = (f0[1] + f1[1]) / 2;
        // where it is going
        if (R.speed > 0 && Math.hypot(R.goalX - R.ax, R.goalY - R.ay) > 24) {
          ctx.globalAlpha = 0.7;
          arrow(fx, fy, sx(R.goalX + c * R.front), sy(R.goalY + s * R.front), T.light, Math.max(1, 1.5 * k), true, 7);
        }
        // whom it attacks
        const E = R.target;
        if (E && E.alive > 0 && E.n > 0) {
          const ex = sx(E.cx), ey = sy(E.cy), dx = ex - fx, dy = ey - fy, l = Math.hypot(dx, dy) || 1;
          const stop = Math.min(l * 0.8, Math.max(8, E.radius * D * 0.6));
          const tx = ex - dx / l * stop, ty = ey - dy / l * stop;
          if (R.order === 'shoot') { ctx.globalAlpha = 0.75; arrow(fx, fy, tx, ty, '#ffd34d', 1 + k * 0.5, true, 6); }
          else if (R.role === 'cavalry' && (R.order === 'approach' || R.order === 'lance' || R.order === 'flank' || R.order === 'melee')) { ctx.globalAlpha = 0.9; arrow(fx, fy, tx, ty, '#ff9a3c', 1.5 + k * 0.75, false, 9); }
          else if ((R.order === 'charge' || R.order === 'engage') && l > 40 * k) { ctx.globalAlpha = 0.85; arrow(fx, fy, tx, ty, '#ff6a58', 1.5 + k * 0.75, false, 9); }
        }
        // the label goes under the footprint (as it is seen on the screen), or over it
        labels.push({ x: (f0[0] + f1[0] + b0[0] + b1[0]) / 4, y: Math.max(f0[1], f1[1], b0[1], b1[1]) + 3 * k, y2: Math.min(f0[1], f1[1], b0[1], b1[1]) - 3 * k, text: `${R.name} ${R.n} · ${ON[R.order] || R.order}`, col: R.engaged > 0.15 ? '#ff8c80' : '#ffffff' });
      }
      // labels never overprint each other: below the footprint, else above it, else nudged down
      ctx.globalAlpha = 1;
      const placed = [];
      const free = (x, y, w, h) => placed.every((q) => x + w <= q.x || q.x + q.w <= x || y + h <= q.y || q.y + q.h <= y);
      for (const L of labels) {
        const cv = S.text(L.text, L.col);
        const w = cv.width * k, h = cv.height * k, x = Math.round(L.x - w / 2);
        let y = Math.round(L.y);
        if (!free(x, y, w, h)) {
          if (L.y2 != null && free(x, Math.round(L.y2 - h), w, h)) y = Math.round(L.y2 - h);
          else for (let i = 0; i < 6 && !free(x, y, w, h); i++) y += h;
        }
        placed.push({ x, y, w, h });
        ctx.fillStyle = 'rgba(10, 8, 6, 0.6)';
        ctx.fillRect(x - k, y - k, w + 2 * k, h + k);
        ctx.drawImage(cv, x, y, w, h);
      }
    }

    drawPings(ctx, B, D, ox, oy, n) {
      const ev = B.events, now = B.time;
      const k = D >= 0.999 ? n : 1;
      for (let i = ev.length - 1; i >= 0; i--) {
        const e = ev[i], age = now - e.time;
        if (age > 3.2) break;
        const P = PING[e.kind];
        if (!P || e.x == null) continue;
        const col = P[0] || TM.TEAMS[e.team].light;
        for (let w = 0; w < 2; w++) {          // two rings, the second a little behind
          const t = (age - w * 0.35) / P[2];
          if (t < 0 || t >= 1) continue;
          const e1 = 1 - (1 - t) * (1 - t);
          const r = Math.max(3, Math.min((8 + P[1] * e1) * D, 110 * e1 + 8)); // close up a ping stays small
          ctx.globalAlpha = (1 - t) * (w ? 0.45 : 0.85);
          ellipse(ctx, e.x * D + ox, e.y * D + oy, r, col, k);
        }
      }
      // the event under the mouse in the feed: a steady marker
      const f = this.focusEvent;
      if (f && f.x != null) {
        const col = (PING[f.kind] && PING[f.kind][0]) || TM.TEAMS[f.team].light;
        ctx.globalAlpha = 0.95;
        ellipse(ctx, f.x * D + ox, f.y * D + oy, Math.max(6, (24 + 6 * Math.sin(performance.now() / 160)) * D), col, k);
      }
      ctx.globalAlpha = 1;
    }

    drawRing(ctx, u, col, D, ox, oy, n) {
      if (!u || u.state !== ALIVE) return;
      const r = Math.max(2, Math.round(u.r * Math.min(1, D) * (u.def.mounted ? 1.3 : 1)));
      const cv = TM.Sprites.ring(r, col);
      const px = Math.round(u.x * D + ox), py = Math.round(u.y * D + oy);
      ctx.drawImage(cv, px - Math.floor(cv.width / 2) * n, py - Math.floor(cv.height / 2) * n, cv.width * n, cv.height * n);
    }

    // Arrows in flight leave a short streak (where the arrow was ~1/20 s ago) and a moving shadow
    // on the ground: a volley reads as a dark rain sweeping over the field, at any zoom.
    // Position along the flight at parameter s (see Battle.updateArrows).
    drawArrowShadows(ctx, arrows, D, ox, oy, n, vx0, vy0, vx1, vy1) {
      if (!arrows.length) return;
      if (D < 0.6) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        for (let i = 0; i < arrows.length; i++) {
          const p = arrows[i];
          if (p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue;
          ctx.fillRect(Math.round(p.x * D + ox), Math.round(p.y * D + oy), 1, 1);
        }
        return;
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = D < 0.999 ? 1 : n;
      ctx.beginPath();
      for (let i = 0; i < arrows.length; i++) {
        const p = arrows[i];
        if (p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue;
        const back = Math.min(0.05, 16 / (360 * D)) / p.T; // ~ 1/20 s of flight, at most 16 device px
        const s0 = Math.max(0, (p.s || 0) - back);
        const qx = p.x0 + (p.tx - p.x0) * s0, qy = p.y0 + (p.ty - p.y0) * s0;
        ctx.moveTo(Math.round(qx * D + ox) + 0.5, Math.round(qy * D + oy) + 0.5);
        ctx.lineTo(Math.round(p.x * D + ox) + 0.5, Math.round(p.y * D + oy) + 0.5);
      }
      ctx.stroke();
    }

    drawArrows(ctx, arrows, D, ox, oy, n, si, K, vx0, vy0, vx1, vy1) {
      if (!arrows.length) return;
      const spr = TM.Sprites.arrows[si];
      const close = D >= 1.5;
      // streaks: the arrow itself far away, a faint motion trail behind the sprite close up
      ctx.strokeStyle = close ? 'rgba(244,239,226,0.28)' : 'rgba(46,30,15,0.85)';
      ctx.lineWidth = close ? Math.max(1, n >> 1) : 1;
      ctx.beginPath();
      for (let i = 0; i < arrows.length; i++) {
        const p = arrows[i];
        if (p.x < vx0 || p.x > vx1 || p.y < vy0 - 100 || p.y > vy1 + 100) continue;
        const s = p.s || 0;
        const back = Math.min(0.05, 16 / (360 * D)) / p.T;
        const s0 = Math.max(0, s - back);
        const qx = p.x0 + (p.tx - p.x0) * s0, qy = p.y0 + (p.ty - p.y0) * s0;
        const qz = 6 * (1 - s0) + 4 * p.h * s0 * (1 - s0);
        ctx.moveTo(Math.round(qx * D + ox) + 0.5, Math.round((qy - qz * K) * D + oy) + 0.5);
        ctx.lineTo(Math.round(p.x * D + ox) + 0.5, Math.round((p.y - p.z * K) * D + oy) + 0.5);
      }
      ctx.stroke();
      if (!close && D < 0.52) {
        // far away: a light point for the arrowhead is all that is left of the sprite
        ctx.fillStyle = '#e8e2d0';
        for (let i = 0; i < arrows.length; i++) {
          const p = arrows[i];
          if (p.x < vx0 || p.x > vx1 || p.y < vy0 - 100 || p.y > vy1 + 100) continue;
          ctx.fillRect(Math.round(p.x * D + ox), Math.round((p.y - p.z * K) * D + oy), 1, 1);
        }
        return;
      }
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
      // sparks, and wood splinters of broken lances
      ctx.fillStyle = '#ffe28a';
      for (let i = 0; i < cnt; i++) {
        if (type[i] !== 1) continue;
        ctx.fillRect(Math.round(px[i] * D + ox), Math.round((py[i] - pz[i] * K) * D + oy), n, n);
      }
      // breath of exhausted men (close up only)
      if (D >= 1.2) {
        ctx.fillStyle = '#ece8dc';
        for (let i = 0; i < cnt; i++) {
          if (type[i] !== 4) continue;
          ctx.globalAlpha = life[i] / maxLife[i] * 0.6;
          ctx.fillRect(Math.round(px[i] * D + ox), Math.round((py[i] - pz[i] * K) * D + oy), n, n);
        }
        ctx.globalAlpha = 1;
      }
      ctx.fillStyle = '#8b5e31';
      for (let i = 0; i < cnt; i++) {
        if (type[i] !== 3) continue;
        const x = Math.round(px[i] * D + ox), y = Math.round((py[i] - pz[i] * K) * D + oy);
        ctx.fillRect(x, y, n, n); ctx.fillRect(x + (i & 1 ? n : -n), y - n, n, n);
      }
      // dust puffs: chunky pixel clouds fading out (4 alpha steps: few state changes)
      ctx.fillStyle = '#b5a47c';
      for (let b = 3; b >= 0; b--) {
        ctx.globalAlpha = (b + 0.6) / 4 * 0.55;
        for (let i = 0; i < cnt; i++) {
          if (type[i] !== 2) continue;
          if (far && D < 0.6 && (i & 1)) continue;
          const k = life[i] / maxLife[i];
          if ((k * 4 | 0) !== b && !(b === 3 && k >= 1)) continue;
          const x = px[i], y = py[i];
          if (x < vx0 || x > vx1 || y < vy0 || y > vy1) continue;
          const s = Math.max(1, Math.round(size[i] * 0.6 * Math.min(1, D))) * (far ? 1 : n);
          const qx = Math.round(x * D + ox) - (s >> 1), qy = Math.round((y - pz[i] * K) * D + oy) - (s >> 1);
          if (s < 3 * n) ctx.fillRect(qx, qy, s, s);
          else { const c = far ? 1 : n; ctx.fillRect(qx + c, qy, s - 2 * c, s); ctx.fillRect(qx, qy + c, c, s - 2 * c); ctx.fillRect(qx + s - c, qy + c, c, s - 2 * c); } // rounded puff
        }
      }
      ctx.globalAlpha = 1;
    }

    // shock rings of heavy blows: a pixel ellipse growing over the ground and fading
    drawWaves(ctx, fx, D, ox, oy, n) {
      const list = fx.waves;
      if (!list.length || D < 0.3) return;
      const k = D >= 0.999 ? n : 1;
      for (let i = 0; i < list.length; i++) {
        const e = list[i], t = e.t / e.life;
        const r = Math.max(3, e.r * (0.35 + 0.9 * (1 - (1 - t) * (1 - t))) * D);
        ctx.globalAlpha = (1 - t) * (e.strong ? 0.8 : 0.6);
        ellipse(ctx, e.x * D + ox, e.y * D + oy, r, e.strong ? '#e9dcb8' : '#f4efe2', k);
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
        if (hpR < 0.999 && (t === 'giant' || t === 'knight' || t === 'general' || smallBars)) {
          const wa = t === 'giant' ? 22 : t === 'general' ? 18 : u.def.mounted ? 14 : 10;
          const bx = px - ((wa + 2) >> 1) * k, by = top - 4 * k;
          ctx.fillStyle = '#120c0b'; ctx.fillRect(bx, by, (wa + 2) * k, 3 * k);
          ctx.fillStyle = '#3a1a14'; ctx.fillRect(bx + k, by + k, wa * k, k);
          ctx.fillStyle = hpR > 0.5 ? '#7bd14b' : hpR > 0.25 ? '#e8c23a' : '#e2452f';
          ctx.fillRect(bx + k, by + k, Math.max(1, Math.round(wa * hpR)) * k, k);
        }
        if (u.fleeing && D >= 0.4 && (D >= 1.5 || (u.id & 1) === 0)) {
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
