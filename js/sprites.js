// Procedural pixel-art sprite generator.
//
// Every unit class is described as a tiny 3D model made of primitives
// (ellipsoids + tapered capsules) with materials. At load time the models are
// posed for every animation frame, rotated to every facing direction and
// rasterised with an oblique top-down ("3/4") projection into low-res pixel
// buffers: z-buffer, 4-step palette lighting, inner contour darkening,
// 1px dark outline and a cast ground shadow. The results are packed into
// atlases (one per team + a white "hit flash" atlas + corpse variants).
//
// The same models are rasterised at several pixel densities, so a zoomed-out
// army is drawn with native tiny pixel sprites instead of blurry downscales.
(function (TM) {
  'use strict';

  const K = 0.72;                        // screen-y per unit of height (oblique projection)
  const LIGHT = norm([-0.55, 0.32, 0.78]); // light from west, slightly south, above
  const SH_DX = 0.42, SH_DY = -0.16;     // cast-shadow skew per unit of height
  const SCALES = [1, 0.66, 0.4, 0.25];   // art pixels per world unit
  const DIRS = [16, 8, 8, 8];
  const OUTLINE = 255, SHADOW = 254;

  // ------------------------------------------------------------------ materials & palettes
  const M = {
    skin: 1, steel: 2, wood: 3, leather: 4, team: 5, teamDark: 6, trim: 7, horse: 8,
    mane: 9, giant: 10, eye: 11, string: 12, hair: 13, bone: 14, linen: 15, boot: 16, bow: 17,
  };
  const BASE = {
    skin: ['#6e3f2a', '#a5694a', '#d39a72', '#f0c39a'],
    steel: ['#30363f', '#5f6878', '#9ba7b6', '#e3eaf1'],
    wood: ['#3d2716', '#61401f', '#8b5e31', '#b08048'],
    leather: ['#3b2618', '#5f3f25', '#86603a', '#a98052'],
    horse: ['#301d12', '#53321c', '#7a4d2c', '#a06a3e'],
    mane: ['#16100b', '#271b12', '#3a2a1c', '#4f3a27'],
    giant: ['#2c3424', '#4a583a', '#6f8253', '#97ab73'],
    eye: ['#0e0a08', '#0e0a08', '#0e0a08', '#0e0a08'],
    string: ['#b9b09a', '#d8cfb8', '#ece5d2', '#fffbef'],
    hair: ['#1e140c', '#33231a', '#4d3626', '#664a34'],
    bone: ['#7c735f', '#b3a98f', '#dcd3b8', '#f7f1dc'],
    linen: ['#6b624f', '#988d73', '#c2b799', '#e6dcc0'],
    boot: ['#1f1712', '#33251b', '#4a3727', '#5f4833'],
    bow: ['#6a4520', '#a06c32', '#d29a52', '#f2c784'],
  };
  const TEAM_PAL = [
    { // red: crimson + gold
      team: ['#4c0c10', '#8c1a1c', '#cc2f29', '#f2624a'],
      teamDark: ['#2b0709', '#541012', '#7c1b19', '#a42c25'],
      trim: ['#5e3c0f', '#9e6c1b', '#d9a733', '#ffe47e'],
    },
    { // blue: royal blue + silver
      team: ['#0b1847', '#1a3a8c', '#2a68cc', '#62a6f4'],
      teamDark: ['#06102e', '#0e2258', '#173a80', '#2856a8'],
      trim: ['#4a5462', '#8a96a6', '#cdd6e0', '#ffffff'],
    },
  ];
  const OUTLINE_RGB = [18, 12, 11];

  function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  function buildPalette(team, corpse) {
    const pal = [];
    const src = Object.assign({}, BASE, TEAM_PAL[team]);
    for (const name in M) {
      pal[M[name]] = src[name].map((h) => {
        let [r, g, b] = hexRgb(h);
        if (corpse) {
          const grey = (r + g + b) / 3;
          r = (r * 0.78 + grey * 0.22) * 0.74; g = (g * 0.78 + grey * 0.22) * 0.74; b = (b * 0.78 + grey * 0.22) * 0.74;
        }
        return [r | 0, g | 0, b | 0];
      });
    }
    return pal;
  }

  // ------------------------------------------------------------------ vector helpers
  function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // rotation matrices (row-major 3x3) in model space (x fwd, y right, h up)
  function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
  function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; } // +a tips +h toward -x
  function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
  function matMul(A, B) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    return r;
  }
  function apply(m, v) { return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]; }

  // ------------------------------------------------------------------ primitives
  const E = (c, r, m, opt) => Object.assign({ t: 0, c, r, m }, opt);           // ellipsoid
  const C = (a, b, ra, rb, m) => ({ t: 1, a, b, ra, rb: rb == null ? ra : rb, m }); // tapered capsule
  const S = (c, r, m) => ({ t: 0, c, r: [r, r, r], m });

  // ------------------------------------------------------------------ rasteriser
  const BW = 224, BH = 224, AX = 112, AY = 150;
  const zb = new Float32Array(BW * BH), pb = new Uint8Array(BW * BH), shb = new Uint8Array(BW * BH);
  const tmp = new Uint8Array(BW * BH);

  // Sample a posed model once into a point cloud: [x, y, h, nx, ny, nh, code] per point.
  // Pose transforms (p.xf) are baked in; only the facing rotation differs per direction.
  function cloud(prims, step, skipEyes) {
    const out = [];
    let xf = null, code = 0;
    function emit(x, y, h, nx, ny, nh) {
      if (xf) {
        const m = xf.m, px = x - xf.p[0], py = y - xf.p[1], ph = h - xf.p[2];
        x = m[0] * px + m[1] * py + m[2] * ph + xf.p[0] + xf.t[0];
        y = m[3] * px + m[4] * py + m[5] * ph + xf.p[1] + xf.t[1];
        h = m[6] * px + m[7] * py + m[8] * ph + xf.p[2] + xf.t[2];
        if (nx === nx) {
          const a = m[0] * nx + m[1] * ny + m[2] * nh, b = m[3] * nx + m[4] * ny + m[5] * nh, c = m[6] * nx + m[7] * ny + m[8] * nh;
          nx = a; ny = b; nh = c;
        }
      }
      out.push(x, y, h, nx, ny, nh, code);
    }
    for (let k = 0; k < prims.length; k++) {
      const p = prims[k];
      if (skipEyes && p.m === M.eye) continue;
      xf = p.xf || null; code = p.m;
      if (p.t === 0) sampleE(p, step, emit); else sampleC(p, step, emit);
    }
    return Float32Array.from(out);
  }

  // dirty rectangle of the work buffers (cleared lazily)
  let dx0 = 0, dy0 = 0, dx1 = BW - 1, dy1 = BH - 1;

  function raster(pts, yaw, s) {
    const flat = s < 0.7; // small sprites: compress lighting to 2 mid tones -> flat, saturated, readable
    for (let y = dy0; y <= dy1; y++) {
      const o = y * BW;
      zb.fill(-1e9, o + dx0, o + dx1 + 1); pb.fill(0, o + dx0, o + dx1 + 1);
      shb.fill(0, o + dx0, o + dx1 + 1); tmp.fill(0, o + dx0, o + dx1 + 1);
    }
    dx0 = BW; dy0 = BH; dx1 = 0; dy1 = 0;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const L0 = LIGHT[0], L1 = LIGHT[1], L2 = LIGHT[2];
    for (let k = 0; k < pts.length; k += 7) {
      const x = pts[k], y = pts[k + 1], h = pts[k + 2], nx = pts[k + 3], ny = pts[k + 4], nh = pts[k + 5];
      const wx = x * cy - y * sy, wy = x * sy + y * cy;
      if (h >= -0.5) {
        const hh = h > 0 ? h : 0;
        const sx = Math.floor((wx + hh * SH_DX) * s + AX), sY = Math.floor((wy + hh * SH_DY) * s + AY);
        if (sx > 0 && sx < BW - 1 && sY > 0 && sY < BH - 1) {
          shb[sY * BW + sx] = 1;
          if (sx < dx0) dx0 = sx; if (sx > dx1) dx1 = sx; if (sY < dy0) dy0 = sY; if (sY > dy1) dy1 = sY;
        }
      }
      const px = Math.floor(wx * s + AX), py = Math.floor((wy - K * h) * s + AY);
      if (px < 1 || px >= BW - 1 || py < 1 || py >= BH - 1) continue;
      const i = py * BW + px, d = K * wy + h;
      if (d <= zb[i]) continue;
      zb[i] = d;
      let shade = 2;
      if (nx === nx) {
        const l = (nx * cy - ny * sy) * L0 + (nx * sy + ny * cy) * L1 + nh * L2;
        shade = l < -0.12 ? 0 : l < 0.3 ? 1 : l < 0.74 ? 2 : 3;
      }
      if (flat) shade = shade < 2 ? 1 : 2;
      pb[i] = pts[k + 6] * 4 + shade;
      if (px < dx0) dx0 = px; if (px > dx1) dx1 = px; if (py < dy0) dy0 = py; if (py > dy1) dy1 = py;
    }
    // grow dirty rect by 1 for the outline pass
    dx0 = Math.max(1, dx0 - 1); dy0 = Math.max(1, dy0 - 1); dx1 = Math.min(BW - 2, dx1 + 1); dy1 = Math.min(BH - 2, dy1 + 1);
    return finish(s, s < 0.9);
  }

  function sampleE(p, step, emit) {
    const a = p.r[0], b = p.r[1], c = p.r[2];
    const rmax = Math.max(a, b, c);
    const R = p.R, clip = p.clip;
    const nT = Math.max(2, Math.ceil(Math.PI * rmax / step));
    for (let i = 0; i <= nT; i++) {
      const th = Math.PI * i / nT, st = Math.sin(th), ct = Math.cos(th);
      const nP = Math.max(1, Math.ceil(2 * Math.PI * Math.max(a, b) * st / step));
      for (let j = 0; j < nP; j++) {
        const ph = 2 * Math.PI * j / nP;
        const dx = st * Math.cos(ph), dy = st * Math.sin(ph), dh = ct;
        let lx = a * dx, ly = b * dy, lh = c * dh;
        if (clip) {
          let cut = false;
          for (let q = 0; q < clip.length; q++) {
            const cp = clip[q];
            if (cp[0] * lx + cp[1] * ly + cp[2] * lh > cp[3]) { cut = true; break; }
          }
          if (cut) continue;
        }
        let nx = dx / a, ny = dy / b, nh = dh / c;
        if (R) {
          const x2 = R[0] * lx + R[1] * ly + R[2] * lh, y2 = R[3] * lx + R[4] * ly + R[5] * lh, h2 = R[6] * lx + R[7] * ly + R[8] * lh;
          lx = x2; ly = y2; lh = h2;
          const n0 = R[0] * nx + R[1] * ny + R[2] * nh, n1 = R[3] * nx + R[4] * ny + R[5] * nh, n2 = R[6] * nx + R[7] * ny + R[8] * nh;
          nx = n0; ny = n1; nh = n2;
        }
        const nl = Math.hypot(nx, ny, nh) || 1;
        emit(p.c[0] + lx, p.c[1] + ly, p.c[2] + lh, nx / nl, ny / nl, nh / nl);
      }
    }
  }

  function sampleC(p, step, emit) {
    const a = p.a, b = p.b;
    const ax = b[0] - a[0], ay = b[1] - a[1], ah = b[2] - a[2];
    const len = Math.hypot(ax, ay, ah);
    if (len < 1e-4) { sampleE({ c: a, r: [p.ra, p.ra, p.ra] }, step, emit); return; }
    const d = [ax / len, ay / len, ah / len];
    let u = Math.abs(d[2]) < 0.9 ? cross(d, [0, 0, 1]) : cross(d, [1, 0, 0]);
    u = norm(u);
    const v = cross(d, u);
    const nT = Math.max(1, Math.ceil(len / (step * 0.8)));
    const thin = step * 0.7;
    for (let i = 0; i <= nT; i++) {
      const t = i / nT;
      const cx = a[0] + ax * t, cyy = a[1] + ay * t, ch = a[2] + ah * t;
      const r = p.ra + (p.rb - p.ra) * t;
      if (r < thin) { emit(cx, cyy, ch, NaN, 0, 0); continue; }
      const nA = Math.max(6, Math.ceil(2 * Math.PI * r / step));
      for (let k = 0; k < nA; k++) {
        const g = 2 * Math.PI * k / nA, cg = Math.cos(g), sg = Math.sin(g);
        const nx = u[0] * cg + v[0] * sg, ny = u[1] * cg + v[1] * sg, nh = u[2] * cg + v[2] * sg;
        emit(cx + nx * r, cyy + ny * r, ch + nh * r, nx, ny, nh);
      }
    }
    if (p.ra >= thin) sampleE({ c: a, r: [p.ra, p.ra, p.ra] }, step, emit);
    if (p.rb >= thin) sampleE({ c: b, r: [p.rb, p.rb, p.rb] }, step, emit);
  }

  // contour darkening, outline, crop
  // merge=true bakes the cast shadow into the sprite (mid/far zoom: 1 draw call per unit)
  function finish(s, merge) {
    let x0 = BW, y0 = BH, x1 = -1, y1 = -1;
    let sx0 = BW, sy0 = BH, sx1 = -1, sy1 = -1;
    const edge = 2.2 / Math.max(s, 0.5);
    for (let y = dy0; y <= dy1; y++) {
      for (let x = dx0; x <= dx1; x++) {
        const i = y * BW + x;
        if (shb[i]) { if (x < sx0) sx0 = x; if (x > sx1) sx1 = x; if (y < sy0) sy0 = y; if (y > sy1) sy1 = y; }
        if (!pb[i]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (s >= 0.5) {
          const z = zb[i] + edge;
          if ((pb[i - 1] && zb[i - 1] > z) || (pb[i + 1] && zb[i + 1] > z) || (pb[i - BW] && zb[i - BW] > z) || (pb[i + BW] && zb[i + BW] > z)) tmp[i] = 1;
        }
      }
    }
    if (x1 < 0) return null;
    // darken contours
    for (let y = dy0; y <= dy1; y++) for (let x = dx0, i = y * BW + dx0; x <= dx1; x++, i++) if (tmp[i] && (pb[i] & 3)) pb[i]--;
    // crop with 1px border for the outline
    x0--; y0--; x1++; y1++;
    if (merge && sx1 >= 0) { x0 = Math.min(x0, sx0); y0 = Math.min(y0, sy0); x1 = Math.max(x1, sx1); y1 = Math.max(y1, sy1); }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y + y0) * BW + (x + x0);
        if (pb[i]) { data[y * w + x] = pb[i]; continue; }
        if (pb[i - 1] || pb[i + 1] || pb[i - BW] || pb[i + BW]) data[y * w + x] = OUTLINE;
        else if (merge && shb[i]) data[y * w + x] = SHADOW;
      }
    }
    let shadow = null;
    if (sx1 >= 0 && !merge) {
      const sw = sx1 - sx0 + 1, sh = sy1 - sy0 + 1;
      const sd = new Uint8Array(sw * sh);
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sd[y * sw + x] = shb[(y + sy0) * BW + x + sx0];
      shadow = { w: sw, h: sh, ax: AX - sx0, ay: AY - sy0, data: sd };
    }
    return { w, h, ax: AX - x0, ay: AY - y0, data, shadow };
  }

  // ------------------------------------------------------------------ model parts
  function headgear(type, hd, P) {
    const [hx, , hh] = hd;
    if (type === 'helm' || type === 'plume') {
      P.push(E([hx - 0.05, 0, hh + 0.5], [2.55, 2.55, 2.35], M.steel, { clip: [[0, 0, -1, 0.45]] }));
      P.push(C([hx + 2.45, 0, hh + 0.9], [hx + 2.6, 0, hh - 0.5], 0.34, 0.3, M.steel));
      if (type === 'helm') P.push(E([hx - 0.3, 0, hh + 2.75], [2.2, 0.55, 0.95], M.team));
      else P.push(C([hx - 0.4, 0, hh + 2.5], [hx - 3.4, 0, hh - 0.6], 0.95, 0.45, M.team));
    } else if (type === 'hood') {
      P.push(E([hx - 0.2, 0, hh + 0.3], [2.5, 2.55, 2.5], M.team, { clip: [[1, 0, 0, 1.1], [0, 0, -1, 1.3]] }));
      P.push(C([hx - 0.4, 0, hh + 2.4], [hx - 1.6, 0, hh + 3.6], 0.7, 0.35, M.team));
      P.push(C([hx - 2.0, 0, hh - 0.6], [hx - 2.6, 0, hh - 2.8], 0.9, 0.5, M.team));
    } else if (type === 'greathelm') {
      P.push(E([hx, 0, hh + 0.2], [2.5, 2.5, 2.9], M.steel));
      P.push(E([hx + 2.35, 0, hh + 0.4], [0.35, 1.6, 0.36], M.eye));
      P.push(E([hx - 0.1, 0, hh + 1.5], [2.6, 2.6, 0.42], M.trim));
      P.push(C([hx - 0.3, 0, hh + 2.9], [hx - 2.6, 0, hh + 5.0], 1.05, 0.65, M.team));
    }
  }

  // Generic soldier. o: {phase, run, rHand, lHand, torso, arms, gear, bob}
  function humanoid(o) {
    const P = [];
    const ph = o.phase;
    const stride = o.run ? 3.2 : 2.5;
    const sw = ph == null ? 0 : Math.sin(ph), lift = ph == null ? 0 : Math.cos(ph);
    const bob = ph == null ? 0 : Math.abs(sw) * 0.55;
    for (const side of [-1, 1]) {
      const k = side < 0 ? 1 : -1;
      const fx = sw * stride * k, fl = Math.max(0, lift * k) * 1.4;
      const hip = [0, side * 1.5, 5.4 + bob], foot = [fx, side * 1.75, 1.0 + fl];
      P.push(C(hip, foot, 1.2, 1.0, o.legs || M.leather));
      P.push(E([fx + 0.7, side * 1.75, 0.75 + fl], [1.55, 0.95, 0.75], M.boot));
    }
    P.push(E([0, 0, 7.9 + bob], [2.4, 3.15, 3.5], o.torso || M.team));
    P.push(E([0, 0, 6.0 + bob], [2.45, 3.05, 0.75], M.leather));
    if (o.belt) P.push(E([0, 0, 6.0 + bob], [2.5, 3.1, 0.45], M.trim));
    const swing = ph == null ? 0 : sw;
    const rH = o.rHand || [0.6 - swing * 1.6, 3.5, 6.6 + bob];
    const lH = o.lHand || [0.6 + swing * 1.6, -3.5, 6.6 + bob];
    for (const [side, hand] of [[1, rH], [-1, lH]]) {
      const sh = [0, side * 3.0, 9.8 + bob];
      P.push(C(sh, hand, 1.05, 0.85, o.arms || M.teamDark));
      P.push(S(hand, 0.95, M.skin));
    }
    if (o.pauldrons) for (const side of [-1, 1]) P.push(S([0, side * 3.05, 10.0 + bob], 1.35, M.steel));
    const head = [0.25, 0, 12.5 + bob];
    P.push(S(head, 2.3, M.skin));
    P.push(S([head[0] + 2.05, 0.85, head[2] - 0.15], 0.42, M.eye));
    P.push(S([head[0] + 2.05, -0.85, head[2] - 0.15], 0.42, M.eye));
    headgear(o.gear, head, P);
    return { P, bob };
  }

  function shield(P, c, yaw, r1, r2, round) {
    const R = rotZ(yaw);
    const n = apply(R, [1, 0, 0]);
    P.push(E(add(c, mul(n, -0.3)), [0.45, r1 + 0.35, r2 + 0.35], M.trim, { R }));
    P.push(E(c, [0.55, r1, r2], M.team, { R }));
    if (!round) {
      P.push(E(add(c, mul(n, 0.35)), [0.3, 0.42, r2 * 0.85], M.trim, { R }));
      P.push(E(add(c, mul(n, 0.35)), [0.3, r1 * 0.85, 0.42], M.trim, { R }));
    }
    P.push(S(add(c, mul(n, 0.55)), 0.85, M.steel));
  }

  function sword(P, hand, dir) {
    const d = norm(dir);
    let perp = cross(d, [0, 0, 1]);
    if (Math.hypot(perp[0], perp[1], perp[2]) < 0.2) perp = [0, 1, 0];
    perp = norm(perp);
    P.push(C(add(hand, mul(d, -1.3)), add(hand, mul(d, 0.4)), 0.45, 0.45, M.wood));
    P.push(S(add(hand, mul(d, -1.5)), 0.6, M.trim));
    P.push(C(add(add(hand, mul(d, 0.65)), mul(perp, -1.55)), add(add(hand, mul(d, 0.65)), mul(perp, 1.55)), 0.42, 0.42, M.trim));
    P.push(C(add(hand, mul(d, 0.9)), add(hand, mul(d, 9.3)), 0.62, 0.22, M.steel));
  }

  function spear(P, hand, dir, back, fwd) {
    const d = norm(dir);
    const end = add(hand, mul(d, fwd));
    P.push(C(add(hand, mul(d, -back)), end, 0.5, 0.5, M.wood));
    P.push(C(add(end, mul(d, -0.3)), add(end, mul(d, 3.6)), 0.78, 0.08, M.steel));
  }

  function bow(P, grip, up, fwd, pull, arrow) {
    const R = 6.6;
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const th = (-62 + 124 * i / 6) * Math.PI / 180;
      pts.push(add(add(grip, mul(up, R * Math.sin(th))), mul(fwd, (Math.cos(th) - 1) * R * 0.85)));
    }
    for (let i = 0; i < 6; i++) P.push(C(pts[i], pts[i + 1], i === 0 || i === 5 ? 0.5 : 0.7, i === 0 || i === 5 ? 0.5 : 0.7, M.bow));
    const e1 = pts[0], e2 = pts[6];
    if (pull) {
      P.push(C(e1, pull, 0.26, 0.26, M.string));
      P.push(C(pull, e2, 0.26, 0.26, M.string));
      if (arrow) {
        const tip = add(grip, mul(fwd, 1.8));
        P.push(C(pull, tip, 0.3, 0.3, M.wood));
        P.push(C(tip, add(tip, mul(fwd, 1.3)), 0.5, 0.08, M.steel));
        P.push(C(pull, add(pull, mul(fwd, 1.2)), 0.55, 0.3, M.linen));
      }
    } else {
      P.push(C(e1, e2, 0.26, 0.26, M.string));
    }
  }

  // ------------------------------------------------------------------ class models
  const PH = (f) => f * Math.PI / 2;          // 4-frame walk cycle phase
  const RAISED = (bob) => [[0.7, 3.2, 16.2 + bob], [0.7, -3.2, 16.2 + bob]]; // hands up (panic)

  const MODELS = {
    sword(anim, f) {
      if (anim === 'flee') {
        const [r, l] = RAISED(0.3);
        return humanoid({ phase: PH(f), run: true, gear: 'helm', belt: true, rHand: r, lHand: l }).P;
      }
      const ph = anim === 'walk' ? PH(f) : null;
      const swing = ph == null ? 0 : Math.sin(ph);
      let rHand = [1.8 - swing * 0.9, 3.5, 7.0], sdir = [0.55, 0.1, 0.83];
      if (anim === 'attack') {
        rHand = [[-0.6, 3.5, 12.8], [3.9, 1.0, 8.6], [2.4, -1.6, 6.4]][f];
        sdir = [[-0.35, 0.35, 0.87], [0.8, -0.5, -0.3], [0.3, -0.82, -0.48]][f];
      }
      const hu = humanoid({ phase: ph, gear: 'helm', belt: true, rHand, lHand: [2.2, -2.7, 8.0] });
      const P = hu.P;
      sword(P, [rHand[0], rHand[1], rHand[2]], sdir);
      shield(P, [2.95, -3.15, 8.5 + hu.bob], -0.55, 3.0, 3.45, false);
      return P;
    },

    spear(anim, f) {
      if (anim === 'flee') {
        const [r, l] = RAISED(0.3);
        return humanoid({ phase: PH(f), run: true, gear: 'plume', rHand: r, lHand: l }).P;
      }
      const leveled = anim === 'ready' || anim === 'walkReady' || anim === 'attack';
      const ph = anim === 'walk' || anim === 'walkReady' ? PH(f) : null;
      const swing = ph == null ? 0 : Math.sin(ph);
      let P, bob;
      if (leveled) {
        const off = anim === 'attack' ? [-2.6, 5.6, 3.0][f] : 0;
        const rHand = [0.4 + off, 2.1, 8.6], lHand = [3.1 + off * 0.8, 0.9, 8.9];
        ({ P, bob } = humanoid({ phase: ph, gear: 'plume', rHand, lHand }));
        spear(P, [rHand[0], rHand[1], rHand[2] + bob], [1, -0.06, 0.04], 7.5, 17.5);
      } else {
        const rHand = [1.4 - swing * 0.5, 3.2, 8.0];
        ({ P, bob } = humanoid({ phase: ph, gear: 'plume', rHand }));
        spear(P, [rHand[0], rHand[1], rHand[2] + bob], [0.16, 0.04, 1], 6.5, 15);
      }
      shield(P, [0.2, -3.75, 9.0 + bob], -Math.PI / 2 + 0.25, 2.4, 2.4, true);
      return P;
    },

    archer(anim, f) {
      if (anim === 'flee') {
        const [r, l] = RAISED(0.3);
        return humanoid({ phase: PH(f), run: true, gear: 'hood', torso: M.leather, arms: M.linen, rHand: r, lHand: l }).P;
      }
      const ph = anim === 'walk' ? PH(f) : null;
      const swing = ph == null ? 0 : Math.sin(ph);
      let rHand, lHand;
      if (anim === 'aim') { lHand = [5.3, -0.5, 10.4]; rHand = [0.9, 0.7, 10.6]; }
      else if (anim === 'release') { lHand = [5.3, -0.5, 10.4]; rHand = [-0.6, 1.9, 10.9]; }
      else if (anim === 'attack') { lHand = [2.6, -2.4, 8.2]; rHand = [[0.2, 3.4, 9.4], [4.8, 1.4, 8.8], [3.8, 0.8, 7.6]][f]; }
      else { lHand = [2.6 + swing * 0.6, -2.4, 8.2]; rHand = null; }
      const hu = humanoid({ phase: ph, gear: 'hood', torso: M.leather, arms: M.linen, rHand, lHand });
      const P = hu.P, b = hu.bob;
      // team sash + quiver
      P.push(C([1.85, -2.5, 9.8 + b], [2.05, 2.4, 6.5 + b], 0.75, 0.75, M.team));
      P.push(C([-2.4, 1.2, 6.4 + b], [-2.9, 1.9, 11.7 + b], 1.05, 1.0, M.leather));
      for (let k = -1; k <= 1; k++) P.push(C([-2.9 + k * 0.3, 1.9 + k * 0.5, 11.9 + b], [-3.0 + k * 0.3, 1.9 + k * 0.5, 13.0 + b], 0.4, 0.4, M.linen));
      const lh = [lHand[0], lHand[1], lHand[2] + b];
      if (anim === 'aim') bow(P, lh, norm([0, -0.12, 1]), [1, 0, 0], [rHand[0], rHand[1], rHand[2] + b], true);
      else if (anim === 'release') bow(P, lh, norm([0, -0.12, 1]), [1, 0, 0], null, false);
      else bow(P, lh, norm([0.35, -0.25, 1]), norm([0.8, -0.6, 0]), null, false);
      if (anim === 'attack') {
        const rh = [rHand[0], rHand[1], rHand[2] + b], d = norm([1, -0.15, 0.1]);
        P.push(C(rh, add(rh, mul(d, 3.4)), 0.42, 0.14, M.steel));
      }
      return P;
    },

    knight(anim, f) {
      const gallop = anim === 'walk' || anim === 'charge';
      const ph = gallop ? PH(f) : null;
      const leveled = anim === 'charge' || anim === 'ready' || anim === 'attack';
      const P = [];
      const bob = ph == null ? 0 : Math.sin(ph * 2) * 0.4;
      // --- horse
      const H = [];
      H.push(E([-0.2, 0, 7.3 + bob], [6.9, 3.3, 3.15], M.team));
      H.push(E([-0.2, 0, 4.7 + bob], [6.95, 3.35, 0.45], M.trim));
      H.push(C([4.6, 0, 9.2 + bob], [7.4, 0, 12.7 + bob], 2.1, 1.55, M.horse));
      H.push(C([4.0, 0, 11.1 + bob], [6.9, 0, 14.5 + bob], 0.85, 0.6, M.mane));
      H.push(E([9.1, 0, 12.4 + bob], [2.7, 1.35, 1.55], M.horse, { R: rotY(-0.55) }));
      H.push(E([7.1, 0, 12.0 + bob], [2.6, 1.85, 1.9], M.team, { clip: [[1, 0, 0, 1.2]] }));
      for (const sd of [-1, 1]) {
        H.push(S([9.0, sd * 1.25, 13.3 + bob], 0.36, M.eye));
        H.push(C([7.6, sd * 0.7, 14.3 + bob], [7.3, sd * 0.85, 15.7 + bob], 0.45, 0.3, M.mane));
      }
      const tailSw = ph == null ? 0 : Math.sin(ph) * 0.9;
      H.push(C([-6.7, 0, 8.8 + bob], [-9.1, tailSw, 4.8 + bob], 1.1, 0.6, M.mane));
      const legs = [[4.0, -1.6, 0], [4.0, 1.6, 0.7], [-4.2, -1.6, Math.PI], [-4.2, 1.6, Math.PI + 0.7]];
      for (const [lx, ly, off] of legs) {
        const a = ph == null ? 0 : Math.sin(ph + off) * 0.62;
        const lift = ph == null ? 0 : Math.max(0, Math.sin(ph + off + Math.PI / 2)) * 1.3;
        const hip = [lx, ly, 6.0 + bob], hoof = [lx + Math.sin(a) * 5.6, ly, 0.6 + lift];
        H.push(C(hip, hoof, 0.95, 0.6, M.horse));
        H.push(E(hoof, [0.75, 0.6, 0.5], M.mane));
      }
      // --- rider
      const Rr = [];
      const sb = bob + 0.0;
      for (const sd of [-1, 1]) {
        Rr.push(C([-0.6, sd * 1.7, 11.2 + sb], [1.2, sd * 3.35, 10.2 + sb], 1.05, 0.95, M.steel));
        Rr.push(C([1.2, sd * 3.35, 10.2 + sb], [0.7, sd * 3.45, 7.6 + sb], 0.9, 0.8, M.steel));
        Rr.push(E([1.3, sd * 3.45, 7.2 + sb], [1.3, 0.8, 0.7], M.boot));
      }
      Rr.push(E([-0.7, 0, 14.2 + sb], [2.1, 2.8, 2.9], M.team));
      Rr.push(E([-0.7, 0, 12.2 + sb], [2.2, 2.85, 0.6], M.leather));
      for (const sd of [-1, 1]) Rr.push(S([-0.7, sd * 2.9, 16.1 + sb], 1.05, M.steel));
      headgear('greathelm', [-0.45, 0, 18.0 + sb], Rr);
      let rHand;
      if (leveled) {
        const off = anim === 'attack' ? [-2.5, 5.0, 2.5][f] : 0;
        rHand = [0.9 + off, 3.0, 13.4 + sb];
        const d = norm([1, -0.05, -0.07]);
        Rr.push(C(add(rHand, mul(d, -6)), add(rHand, mul(d, 20)), 0.55, 0.5, M.wood));
        Rr.push(C(add(rHand, mul(d, 20)), add(rHand, mul(d, 23.4)), 0.65, 0.08, M.steel));
        Rr.push(S(add(rHand, mul(d, 1.2)), 1.15, M.steel));
        Rr.push(E(add(add(rHand, mul(d, 16.5)), [0, -1.3, 0.3]), [1.6, 1.0, 0.18], M.team));
      } else {
        rHand = [0.4, 3.1, 13.6 + sb];
        const d = norm([0.12, 0.05, 1]);
        Rr.push(C(add(rHand, mul(d, -4)), add(rHand, mul(d, 16.5)), 0.55, 0.5, M.wood));
        Rr.push(C(add(rHand, mul(d, 16.5)), add(rHand, mul(d, 19.5)), 0.65, 0.08, M.steel));
        Rr.push(E(add(add(rHand, mul(d, 14.2)), [-1.4, 0, 0]), [1.6, 0.18, 1.0], M.team));
      }
      const lHand = [1.6, -1.6, 12.6 + sb];
      for (const [sd, hand] of [[1, rHand], [-1, lHand]]) {
        Rr.push(C([-0.7, sd * 3.0, 15.8 + sb], hand, 1.0, 0.85, M.teamDark));
        Rr.push(S(hand, 0.9, M.steel));
      }
      shield(Rr, [0.3, -3.6, 14.0 + sb], -Math.PI / 2 + 0.35, 2.5, 3.5, false);
      for (const p of H) { p.g = 'horse'; P.push(p); }
      for (const p of Rr) { p.g = 'rider'; P.push(p); }
      return P;
    },

    giant(anim, f) {
      const ph = anim === 'walk' ? PH(f) : null;
      const sw = ph == null ? 0 : Math.sin(ph), lift = ph == null ? 0 : Math.cos(ph);
      const bob = ph == null ? 0 : Math.abs(sw) * 0.9;
      const P = [];
      for (const side of [-1, 1]) {
        const k = side < 0 ? 1 : -1;
        const fx = sw * 4.5 * k, fl = Math.max(0, lift * k) * 2.2;
        P.push(C([0, side * 3.6, 11.5 + bob], [fx, side * 3.9, 2.0 + fl], 2.8, 2.3, M.giant));
        P.push(E([fx + 1.4, side * 3.9, 1.3 + fl], [2.9, 2.0, 1.4], M.giant));
      }
      P.push(E([0, 0, 11.8 + bob], [5.6, 6.9, 2.9], M.leather));
      P.push(E([0.6, 0, 17.5 + bob], [5.6, 7.0, 6.2], M.giant));
      P.push(E([0.2, 0, 22.4 + bob], [5.2, 7.6, 4.2], M.giant));
      P.push(E([0, 0, 13.6 + bob], [5.9, 7.15, 0.95], M.team));
      P.push(C([4.4, 6.0, 24.3 + bob], [5.5, -5.2, 14.6 + bob], 1.05, 1.05, M.team));
      P.push(E([0, 7.4, 24.8 + bob], [3.5, 3.5, 2.5], M.team));
      P.push(E([0, -7.4, 24.4 + bob], [2.6, 2.6, 1.6], M.leather));
      let rHand = [2.0 - sw * 2, 9.2, 13.5 + bob], cdir = [0.8, 0.15, -0.45];
      const lHand = [2.2 + sw * 2, -8.8, 13.8 + bob];
      if (anim === 'attack') {
        rHand = [[-1.2, 6.8, 32.5], [7.6, 3.0, 17.0], [6.0, -2.5, 11.0]][f];
        cdir = [[-0.45, 0.15, 0.88], [0.75, -0.2, -0.62], [0.4, -0.7, -0.6]][f];
      }
      for (const [side, hand] of [[1, rHand], [-1, lHand]]) {
        P.push(C([0, side * 8.0, 23.5 + bob], hand, 2.6, 2.2, M.giant));
        P.push(S(hand, 2.5, M.giant));
      }
      const hd = [2.6, 0, 28.2 + bob];
      P.push(E(hd, [3.8, 3.6, 3.6], M.giant));
      P.push(E([hd[0] + 2.0, 0, hd[2] + 1.3], [1.5, 3.2, 0.9], M.giant));
      P.push(E([hd[0] + 3.1, 0, hd[2] + 0.4], [0.7, 3.1, 0.55], M.team));
      for (const sd of [-1, 1]) {
        P.push(S([hd[0] + 3.4, sd * 1.4, hd[2] + 0.75], 0.62, M.eye));
        P.push(C([hd[0] + 3.5, sd * 1.6, hd[2] - 1.7], [hd[0] + 4.1, sd * 1.9, hd[2] + 0.1], 0.6, 0.25, M.bone));
        P.push(C([hd[0] - 0.5, sd * 3.4, hd[2] + 0.6], [hd[0] - 0.9, sd * 4.6, hd[2] + 1.6], 0.8, 0.4, M.giant));
      }
      // club
      const d = norm(cdir);
      P.push(C(add(rHand, mul(d, -2.2)), add(rHand, mul(d, 13)), 1.0, 2.0, M.wood));
      const knob = add(rHand, mul(d, 14.6));
      P.push(S(knob, 3.1, M.wood));
      const spikes = [[0, 1, 0.3], [0, -1, 0.3], [0.2, 0.3, 1], [0.3, -0.2, -1], [1, 0, 0.2]];
      for (const sp of spikes) {
        const sdv = norm(sp);
        P.push(C(add(knob, mul(sdv, 2.6)), add(knob, mul(sdv, 4.6)), 0.6, 0.1, M.steel));
      }
      return P;
    },
  };

  // Death = idle pose falling over (knights: horse rolls over, rider is thrown).
  function deathModel(cls, f) {
    const k = [0.38, 0.75, 1][f];
    if (cls === 'knight') {
      const P = MODELS.knight('idle', 0);
      const a = k * Math.PI / 2;
      for (const p of P) {
        if (p.g === 'horse') p.xf = { m: rotX(-a), p: [0, 0, 0], t: [0, 0, 3.3 * Math.sin(a)] };
        else p.xf = { m: rotY(a * 1.05), p: [-0.6, 0, 11], t: [-3.5 * k, 7 * k, -8.5 * k + 1.6 * k] };
      }
      return P;
    }
    const P = MODELS[cls]('idle', 0);
    const fwd = cls === 'giant';
    const a = (fwd ? -1 : 1) * k * Math.PI / 2 * 0.98;
    const lift = (fwd ? 6.2 : 2.5) * Math.sin(Math.abs(a));
    const m = rotY(a);
    for (const p of P) p.xf = { m, p: [0, 0, 0], t: [0, 0, lift] };
    return P;
  }

  // Recoil from a blow: the fighting pose rocked back on the heels (horsemen and giants just flash).
  function hurtModel(cls) {
    const P = cls === 'spear' ? MODELS.spear('ready', 0) : MODELS[cls]('idle', 0);
    const m = rotY(0.26);
    for (const p of P) p.xf = { m, p: [0, 0, 0], t: [-0.7, 0, 0] };
    return P;
  }

  const ANIMS = {
    sword: [['idle', 1], ['walk', 4], ['attack', 3], ['hurt', 1], ['flee', 4], ['death', 3]],
    spear: [['idle', 1], ['walk', 4], ['ready', 1], ['walkReady', 4], ['attack', 3], ['hurt', 1], ['flee', 4], ['death', 3]],
    archer: [['idle', 1], ['walk', 4], ['aim', 1], ['release', 1], ['attack', 3], ['hurt', 1], ['flee', 4], ['death', 3]],
    knight: [['idle', 1], ['walk', 4], ['ready', 1], ['charge', 4], ['attack', 3], ['death', 3]],
    giant: [['idle', 1], ['walk', 4], ['attack', 3], ['death', 3]],
  };

  // ------------------------------------------------------------------ atlas building
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  // A small pixel sprite from a grid of [r,g,b] (or null), with the same 1px dark outline as the units.
  // halo: one more, half-transparent dark ring (and 1px of padding) so a marker stands out from a crowd.
  function gridSprite(w, h, pix, outline, halo) {
    const p = halo ? 1 : 0, W = w + 2 * p, H = h + 2 * p;
    const cv = makeCanvas(W, H), c = cv.getContext('2d');
    const img = c.createImageData(W, H), d = img.data;
    const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? pix[y * w + x] : null);
    const near = (x, y) => at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1);
    for (let y = -p; y < h + p; y++) for (let x = -p; x < w + p; x++) {
      let col = at(x, y), a = 255;
      if (!col && outline && near(x, y)) col = OUTLINE_RGB;
      else if (!col && halo && (near(x - 1, y) || near(x + 1, y) || near(x, y - 1) || near(x, y + 1) || at(x - 1, y - 1) || at(x + 1, y - 1) || at(x - 1, y + 1) || at(x + 1, y + 1))) { col = OUTLINE_RGB; a = 120; }
      if (!col) continue;
      const o = ((y + p) * W + x + p) * 4;
      d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = a;
    }
    c.putImageData(img, 0, 0);
    return cv;
  }

  // ------------------------------------------------------------------ regiment standards
  // A swallow-tailed flag in the team colours with the emblem of the arm, flying in the wind
  // (to the east) in 4 frames; and the same standard fallen on the ground (baked into the field
  // where a regiment broke or died).
  const EMBLEM = {
    sword: ['..#..', '..#..', '..#..', '.###.', '..#..'],
    spear: ['..#..', '.###.', '#.#.#', '..#..', '..#..'],
    archer: ['.##.#', '#..##', '#..#.', '#..##', '.##.#'],
    knight: ['.###.', '#...#', '#...#', '#...#', '##.##'],
    giant: ['.###.', '#####', '#.#.#', '#####', '.#.#.'],
  };
  const BANNER = { W: 16, H: 28, CW: 12, CH: 8, TOP: 2, AX: 1 }; // AX: pole column; anchor = pole foot
  function makeBanner(team, type, f) {
    const { W, H, CW, CH, TOP } = BANNER;
    const pix = new Array(W * H).fill(null);
    const P = TEAM_PAL[team];
    const cloth = [hexRgb(P.team[1]), hexRgb(P.team[2]), hexRgb(P.team[3])];
    const trim = [hexRgb(P.trim[1]), hexRgb(P.trim[2]), hexRgb(P.trim[3])];
    const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) pix[y * W + x] = c; };
    for (let y = TOP; y < H - 1; y++) set(1, y, hexRgb(y < TOP + CH ? '#8b5e31' : '#6e4a26'));
    set(1, TOP - 1, trim[2]);
    const em = EMBLEM[type];
    const ph = f * Math.PI / 2;
    for (let i = 0; i < CW; i++) {
      const amp = Math.min(1, i / 4) * 1.3;
      const off = Math.round(Math.sin(i * 0.78 - ph) * amp);
      const sl = Math.cos(i * 0.78 - ph) * Math.min(1, i / 3);
      const shade = sl > 0.45 ? 2 : sl < -0.45 ? 0 : 1;
      for (let j = 0; j < CH; j++) {
        if ((i === CW - 2 && j >= 3 && j <= 4) || (i === CW - 1 && j >= 2 && j <= 5)) continue; // swallowtail
        let col = cloth[shade];
        if (j === CH - 1) col = trim[shade === 0 ? 0 : 1];                     // fringe
        const ex = i - 2, ey = j - 1;
        if (ex >= 0 && ex < 5 && ey >= 0 && ey < 5 && em[ey][ex] === '#') col = trim[shade === 0 ? 1 : 2];
        set(2 + i, TOP + j + off, col);
      }
    }
    return [gridSprite(W, H, pix, true), gridSprite(W, H, pix, true, true)];
  }
  function makeFallen(team) {
    const W = 19, H = 10;
    const pix = new Array(W * H).fill(null);
    const P = TEAM_PAL[team];
    const dim = (h, k) => hexRgb(h).map((v) => (v * k) | 0);
    const cloth = [dim(P.team[0], 1), dim(P.team[1], 0.9), dim(P.team[2], 0.8)];
    const set = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) pix[y * W + x] = c; };
    for (let i = 0; i <= 15; i++) set(1 + i, Math.round(8 - i * 0.36), dim('#6e4a26', 0.85));
    const shape = ['.####..', '######.', '#######', '.#####.', '..##...'];
    shape.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '#') set(10 + x, 2 + y, cloth[(x * 3 + y * 5) % 7 < 2 ? 0 : (x + y) % 3 === 0 ? 2 : 1]);
    }));
    set(12, 3, dim(P.trim[2], 0.8)); set(13, 4, dim(P.trim[2], 0.8));
    return gridSprite(W, H, pix, true);
  }

  function pack(frames, key, width) {
    const order = frames.map((f, i) => i).filter((i) => frames[i][key]).sort((a, b) => frames[b][key].h - frames[a][key].h);
    let x = 0, y = 0, rowH = 0;
    for (const i of order) {
      const fr = frames[i][key];
      if (x + fr.w > width) { x = 0; y += rowH + 1; rowH = 0; }
      fr.x = x; fr.y = y;
      x += fr.w + 1;
      if (fr.h > rowH) rowH = fr.h;
    }
    return y + rowH + 1;
  }

  function paint(frames, key, width, height, colorFn) {
    const cv = makeCanvas(width, height);
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(width, height);
    const d = img.data;
    for (const f of frames) {
      const fr = f[key];
      if (!fr) continue;
      for (let y = 0; y < fr.h; y++) {
        for (let x = 0; x < fr.w; x++) {
          const v = fr.data[y * fr.w + x];
          if (!v) continue;
          const rgb = colorFn(v);
          if (!rgb) continue;
          const o = ((fr.y + y) * width + fr.x + x) * 4;
          d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = rgb[3] == null ? 255 : rgb[3];
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  const WHITE = [255, 255, 255], BLACK = [0, 0, 0];

  const Sprites = {
    K, SCALES, DIRS, ready: false,
    sets: [],       // per scale: { frames meta, color:[team0, team1], flash, shadow }
    corpse: null,   // { meta[cls][dir], canvas[team] }
    genMs: 0,

    init() {
      if (this.ready) return;
      const t0 = performance.now();
      const pals = [buildPalette(0, false), buildPalette(1, false)];
      const cpals = [buildPalette(0, true), buildPalette(1, true)];
      const SHADOW_RGBA = [0, 0, 0, 77];
      const colorOf = (pal) => (v) => (v === OUTLINE ? OUTLINE_RGB : v === SHADOW ? SHADOW_RGBA : pal[v >> 2][v & 3]);

      // Pose every frame once (model space), reuse for all scales & directions.
      const poses = {};
      for (const cls of TM.UNIT_ORDER) {
        poses[cls] = {};
        for (const [anim, n] of ANIMS[cls]) {
          poses[cls][anim] = [];
          for (let f = 0; f < n; f++) poses[cls][anim].push(anim === 'death' ? deathModel(cls, f) : anim === 'hurt' ? hurtModel(cls) : MODELS[cls](anim, f));
        }
      }

      for (let si = 0; si < SCALES.length; si++) {
        const s = SCALES[si], nd = DIRS[si];
        const step = Math.min(1.6, 0.36 / s);
        const frames = [];
        const meta = {};
        const clouds = {};
        for (const cls of TM.UNIT_ORDER) {
          meta[cls] = {};
          const big = cls === 'giant' ? 1.25 : 1;
          clouds[cls] = {};
          for (const [anim] of ANIMS[cls]) clouds[cls][anim] = poses[cls][anim].map((pr) => cloud(pr, step * big, s < 0.6));
          for (const [anim, n] of ANIMS[cls]) {
            const byDir = [];
            for (let d = 0; d < nd; d++) {
              const yaw = d * Math.PI * 2 / nd;
              const list = [];
              for (let f = 0; f < n; f++) {
                const r = raster(clouds[cls][anim][f], yaw, s);
                const rec = { body: r, shadow: r.shadow };
                frames.push(rec);
                list.push(rec);
              }
              byDir.push(list);
            }
            meta[cls][anim] = byDir;
          }
        }
        const W = 2048;
        const hb = pack(frames, 'body', W);
        const hs = pack(frames, 'shadow', W);
        const set = {
          s, nd, meta,
          color: [paint(frames, 'body', W, hb, colorOf(pals[0])), paint(frames, 'body', W, hb, colorOf(pals[1]))],
          flash: paint(frames, 'body', W, hb, (v) => (v === OUTLINE ? OUTLINE_RGB : v === SHADOW ? null : WHITE)),
          shadow: paint(frames, 'shadow', W, hs, () => BLACK),
        };
        // free raw pixel data
        for (const fr of frames) { fr.body.data = null; if (fr.shadow) fr.shadow.data = null; }
        this.sets.push(set);

        if (si === 0) {
          // corpse variants (last death frame) for baking into the ground layer
          const cf = [], cmeta = {};
          for (const cls of TM.UNIT_ORDER) {
            cmeta[cls] = [];
            for (let d = 0; d < nd; d++) {
              const r = raster(clouds[cls].death[2], d * Math.PI * 2 / nd, s);
              const rec = { body: r };
              cf.push(rec);
              cmeta[cls].push(rec);
            }
          }
          const hc = pack(cf, 'body', 1024);
          this.corpse = {
            meta: cmeta,
            canvas: [paint(cf, 'body', 1024, hc, colorOf(cpals[0])), paint(cf, 'body', 1024, hc, colorOf(cpals[1]))],
          };
        }
      }
      this.buildFx();
      this.genMs = performance.now() - t0;
      this.ready = true;
      this.toBitmaps();
    },

    // ImageBitmap sources are markedly cheaper per drawImage call than canvases.
    // Conversion is async; canvases are used until the bitmaps are ready.
    toBitmaps() {
      if (typeof createImageBitmap !== 'function') return Promise.resolve();
      const jobs = [];
      const conv = (obj, key) => jobs.push(createImageBitmap(obj[key]).then((bm) => { obj[key] = bm; }));
      for (const set of this.sets) {
        conv(set.color, 0); conv(set.color, 1); conv(set, 'flash'); conv(set, 'shadow');
      }
      this.bitmapsReady = Promise.all(jobs).catch(() => {});
      return this.bitmapsReady;
    },

    dirIndex(angle, nd) {
      let d = Math.round(angle / (Math.PI * 2) * nd) % nd;
      if (d < 0) d += nd;
      return d;
    },

    // Bake a corpse into the ground layer (1 px = 1 world unit).
    stampCorpse(g, u) {
      const nd = DIRS[0];
      const d = this.dirIndex(u.facing + u.deathRot * 0.5, nd);
      const fr = this.corpse.meta[u.type][d].body;
      g.drawImage(this.corpse.canvas[u.team], fr.x, fr.y, fr.w, fr.h, Math.round(u.x) - fr.ax, Math.round(u.y) - fr.ay, fr.w, fr.h);
    },

    // Portrait for UI panels.
    drawIcon(canvas, type, team) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const set = this.sets[0];
      const fr = set.meta[type].idle[3][0].body;
      const k = Math.max(1, Math.min(5, Math.floor(Math.min((canvas.width - 6) / fr.w, (canvas.height - 6) / fr.h))));
      ctx.imageSmoothingEnabled = false;
      const dx = Math.round((canvas.width - fr.w * k) / 2), dy = Math.round((canvas.height - fr.h * k) / 2);
      ctx.drawImage(set.color[team], fr.x, fr.y, fr.w, fr.h, dx, dy, fr.w * k, fr.h * k);
    },

    // ---------------------------------------------------------------- FX sprites
    buildFx() {
      // arrows in flight: per scale, 16 screen-space directions
      this.arrows = SCALES.map((s) => {
        const len = Math.max(2, Math.round(7 * s));
        const out = [];
        for (let d = 0; d < 16; d++) {
          const a = d * Math.PI / 8, cx = Math.cos(a), cy = Math.sin(a);
          const sz = len * 2 + 3, cv = makeCanvas(sz, sz), c = cv.getContext('2d');
          const o = (sz - 1) / 2;
          for (let i = 0; i <= len; i++) {
            const t = i / len - 0.5;
            const px = Math.round(o + cx * t * len), py = Math.round(o + cy * t * len);
            c.fillStyle = i === len ? '#e3eaf1' : i <= (len > 3 ? 1 : 0) ? '#f4efe2' : '#4a2f18';
            c.fillRect(px, py, 1, 1);
          }
          out.push(cv);
        }
        return out;
      });
      // arrows stuck in the ground (8 dirs, 1:1 world scale)
      this.stuck = [];
      for (let d = 0; d < 8; d++) {
        const a = d * Math.PI / 4, cx = Math.cos(a), cy = Math.sin(a);
        const cv = makeCanvas(9, 9), c = cv.getContext('2d');
        for (let i = 0; i < 4; i++) {
          c.fillStyle = i === 3 ? '#efe8d6' : '#3f2814';
          c.fillRect(Math.round(4 - cx * i), Math.round(4 - cy * i - i * 0.6), 1, 1);
        }
        this.stuck.push(cv);
      }
      // impact bursts: kinds × 3 frames
      const burst = (core, edge, big) => [0, 1, 2].map((f) => {
        const R = big ? 5 : 4, sz = R * 2 + 1, cv = makeCanvas(sz, sz), c = cv.getContext('2d');
        const px = (x, y, col) => { c.fillStyle = col; c.fillRect(R + x, R + y, 1, 1); };
        if (f === 0) {
          for (let i = -2; i <= 2; i++) { px(i, 0, Math.abs(i) === 2 ? edge : core); px(0, i, Math.abs(i) === 2 ? edge : core); }
          if (big) { px(-1, -1, edge); px(1, 1, edge); px(1, -1, edge); px(-1, 1, edge); px(3, 0, edge); px(-3, 0, edge); px(0, 3, edge); px(0, -3, edge); }
        } else if (f === 1) {
          for (let i = 1; i <= (big ? 4 : 3); i++) { const col = i < 3 ? core : edge; px(i, i, col); px(-i, -i, col); px(i, -i, col); px(-i, i, col); }
          px(0, 0, edge);
        } else {
          const r = big ? 5 : 4;
          px(r, 0, edge); px(-r, 0, edge); px(0, r, edge); px(0, -r, edge);
        }
        return cv;
      });
      this.impacts = {
        hit: burst('#ffffff', '#ffe08a', false),
        block: burst('#fff6b0', '#f0a020', false),
        crit: burst('#ffffff', '#ff4a30', true),
      };
      // slash arcs: 8 dirs × 3 frames
      this.slash = [];
      for (let d = 0; d < 8; d++) {
        const base = d * Math.PI / 4;
        this.slash.push([0, 1, 2].map((f) => {
          const R = 7, sz = R * 2 + 3, cv = makeCanvas(sz, sz), c = cv.getContext('2d');
          const o = (sz - 1) / 2;
          const span = 1.25, n = 14;
          for (let i = 0; i <= n; i++) {
            const t = i / n;
            if (f === 2 && i % 3) continue;
            const a = base - span + 2 * span * t;
            const rr = R - (f === 1 ? 1 : 0);
            const x = Math.round(o + Math.cos(a) * rr), y = Math.round(o + Math.sin(a) * rr);
            c.fillStyle = f === 0 && t > 0.25 && t < 0.75 ? '#ffffff' : '#cfe9ff';
            c.fillRect(x, y, 1, 1);
            if (f === 0 && t > 0.3 && t < 0.7) { c.fillStyle = '#9fd0ff'; c.fillRect(Math.round(o + Math.cos(a) * (rr - 1)), Math.round(o + Math.sin(a) * (rr - 1)), 1, 1); }
          }
          return cv;
        }));
      }
      // panic flag
      {
        const cv = makeCanvas(5, 7), c = cv.getContext('2d');
        c.fillStyle = '#120c0b'; c.fillRect(0, 0, 5, 4); c.fillRect(0, 0, 2, 7);
        c.fillStyle = '#5a3a22'; c.fillRect(0, 1, 1, 6);
        c.fillStyle = '#f4f1e8'; c.fillRect(1, 1, 3, 2);
        this.flag = cv;
      }
      // follow marker (downward chevron)
      {
        const cv = makeCanvas(7, 5), c = cv.getContext('2d');
        const rows = ['1111111', '1222221', '0122210', '0012100', '0001000'];
        rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '0') { c.fillStyle = ch === '1' ? '#120c0b' : '#ffd34d'; c.fillRect(x, y, 1, 1); } }));
        this.marker = cv;
      }
      // regiment standards: [team][type][wave frame], and fallen ones for the ground layer
      this.BANNER = BANNER;
      // (banners: in the scene; bannerMarks: with a dark halo, for medium and far zoom)
      this.banners = [{}, {}]; this.bannerMarks = [{}, {}];
      for (let team = 0; team < 2; team++) {
        for (const type of TM.UNIT_ORDER) {
          const fr = [0, 1, 2, 3].map((f) => makeBanner(team, type, f));
          this.banners[team][type] = fr.map((v) => v[0]);
          this.bannerMarks[team][type] = fr.map((v) => v[1]);
        }
      }
      this.fallen = [makeFallen(0), makeFallen(1)];
      this.rings = {};
      this.texts = new Map();
    },

    // Pixel ellipse ring on the ground (hover / follow), cached per radius & colour.
    ring(r, col) {
      const key = r + col;
      let cv = this.rings[key];
      if (cv) return cv;
      const rx = Math.round(r + 3), ry = Math.round((r + 3) * 0.6);
      cv = makeCanvas(rx * 2 + 3, ry * 2 + 3);
      const c = cv.getContext('2d');
      c.fillStyle = col;
      const n = Math.ceil(rx * 7);
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2;
        c.fillRect(Math.round(rx + 1 + Math.cos(a) * rx), Math.round(ry + 1 + Math.sin(a) * ry), 1, 1);
      }
      this.rings[key] = cv;
      return cv;
    },

    // Crisp pixel text with outline (cached).
    text(str, color) {
      const key = str + '|' + color;
      let cv = this.texts.get(key);
      if (cv) return cv;
      const probe = makeCanvas(8, 8).getContext('2d');
      probe.font = 'bold 10px Arial, Helvetica, sans-serif';
      const w = Math.ceil(probe.measureText(str).width) + 4, h = 13;
      const src = makeCanvas(w, h), sc = src.getContext('2d');
      sc.font = probe.font; sc.textBaseline = 'top'; sc.fillStyle = '#fff';
      sc.fillText(str, 2, 1);
      const id = sc.getImageData(0, 0, w, h).data;
      cv = makeCanvas(w, h);
      const c = cv.getContext('2d');
      const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && id[(y * w + x) * 4 + 3] > 140;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (on(x, y)) { c.fillStyle = color; c.fillRect(x, y, 1, 1); }
        else if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) { c.fillStyle = '#120c0b'; c.fillRect(x, y, 1, 1); }
      }
      if (this.texts.size > 200) this.texts.clear();
      this.texts.set(key, cv);
      return cv;
    },
  };

  TM.Sprites = Sprites;
})(window.TM = window.TM || {});
