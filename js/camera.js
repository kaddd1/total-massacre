// Camera: pan / smooth zoom-to-cursor / fit / fly to a point / auto-director / follow a unit.
//
// Pixel art stays crisp: at rest, a zoom of one device pixel per world unit or more snaps to whole
// device pixels. While the zoom glides from one level to the next (or the camera flies somewhere)
// the view is continuous for a fraction of a second, then settles on the next crisp level.
(function (TM) {
  'use strict';
  const U = TM.U;
  const smooth = (t) => t * t * (3 - 2 * t);

  class Camera {
    constructor() {
      this.x = TM.CONFIG.WORLD_W / 2;
      this.y = TM.CONFIG.WORLD_H / 2;
      this.zoom = 0.5;
      this.minZoom = 0.2;
      this.maxZoom = 5;
      this.auto = false;
      this.follow = null;
      this.followReg = null; // a regiment the camera keeps in view (HUD chip click)
      this.dpr = 1;
      this.ez = this.zoom;
      this.wheelAcc = 0;
      this.glide = null;   // zoom gliding to { z, sx, sy, vw, vh } (zoom about a screen point)
      this.anim = null;    // flight { x0, y0, z0, x1, y1, z1, t, dur }
      this.moving = false; // continuous (unsnapped) view this frame
      this.aim = null;     // auto-director target { x, y, z }
      this.aimT = 0; this.closeT = 0;
    }

    // Effective zoom actually used for drawing. When a world unit covers >= 1 device
    // pixel, zoom snaps to integer device-pixel levels so pixel art stays crisp (except mid-glide).
    view() {
      const D = this.zoom * this.dpr;
      this.ez = D >= 0.999 && !this.moving ? Math.max(1, Math.round(D)) / this.dpr : this.zoom;
      return this.ez;
    }

    // the zoom a glide is heading to (repeated wheel notches add up)
    goalZoom() { return this.glide ? this.glide.z : this.anim ? this.anim.z1 : this.zoom; }

    // One zoom "notch": continuous below 1 device px / unit, integer levels above.
    stepZoom(dir, sx, sy, vw, vh) {
      const D = this.goalZoom() * this.dpr;
      let nD;
      if (D < 0.999) { nD = D * (dir > 0 ? 1.2 : 1 / 1.2); if (nD > 1) nD = 1; }
      else { nD = Math.round(D) + dir; if (nD < 1) nD = 0.85; }
      this.glideTo(nD / this.dpr, sx, sy, vw, vh);
    }

    glideTo(z, sx, sy, vw, vh) {
      this.anim = null;
      this.glide = { z: U.clamp(z, this.minZoom, this.maxZoom), sx, sy, vw, vh };
      this.moving = true;
    }

    wheel(dy, sx, sy, vw, vh) {
      const D = this.goalZoom() * this.dpr, f = Math.exp(-dy * 0.0015);
      if (D < 0.999 && D * f < 0.999) { this.wheelAcc = 0; this.glideTo(this.goalZoom() * f, sx, sy, vw, vh); return; }
      this.wheelAcc += dy;
      if (Math.abs(this.wheelAcc) < 60) return;
      const dir = this.wheelAcc < 0 ? 1 : -1;
      this.wheelAcc = 0;
      this.stepZoom(dir, sx, sy, vw, vh);
    }

    // zoom level that frames `rect` inside the screen area left free by UI insets {l, r, t, b}
    fitZoom(vw, vh, r, i) {
      const aw = Math.max(200, vw - i.l - i.r), ah = Math.max(150, vh - i.t - i.b);
      let z = U.clamp(Math.min(aw / (r.x1 - r.x0), ah / (r.y1 - r.y0)), this.minZoom, this.maxZoom);
      if (z * this.dpr >= 1) z = Math.floor(z * this.dpr) / this.dpr; // whole content must fit
      return z;
    }

    // Frames `rect` inside the screen area left free by UI insets; glide = fly there smoothly.
    fit(vw, vh, rect, ins, glide) {
      const r = rect || { x0: 0, y0: 0, x1: TM.CONFIG.WORLD_W, y1: TM.CONFIG.WORLD_H };
      const i = ins || { l: 0, r: 0, t: 0, b: 0 };
      const z = this.fitZoom(vw, vh, r, i);
      const x = (r.x0 + r.x1) / 2 - (i.l - i.r) / 2 / z, y = (r.y0 + r.y1) / 2 - (i.t - i.b) / 2 / z;
      if (glide) { this.flyTo(x, y, z, 0.7); return; }
      this.anim = this.glide = null; this.moving = false;
      this.zoom = z; this.x = x; this.y = y;
      this.view();
    }

    // smooth flight to a point (and zoom)
    flyTo(x, y, zoom, dur) {
      this.glide = null;
      this.anim = { x0: this.x, y0: this.y, z0: this.zoom, x1: x, y1: y, z1: zoom == null ? this.goalZoom() : U.clamp(zoom, this.minZoom, this.maxZoom), t: 0, dur: dur || 0.6 };
      this.moving = true;
    }

    stop() { this.anim = null; this.glide = null; }

    toWorld(sx, sy, vw, vh) {
      const z = this.view();
      return { x: (sx - vw / 2) / z + this.x, y: (sy - vh / 2) / z + this.y };
    }

    zoomAt(sx, sy, factor, vw, vh) {
      const before = this.toWorld(sx, sy, vw, vh);
      this.zoom = U.clamp(this.zoom * factor, this.minZoom, this.maxZoom);
      const after = this.toWorld(sx, sy, vw, vh);
      this.x += before.x - after.x;
      this.y += before.y - after.y;
      this.clamp();
    }

    pan(dxScreen, dyScreen) {
      this.anim = null;
      this.followReg = null;
      const z = this.view();
      this.x -= dxScreen / z;
      this.y -= dyScreen / z;
      this.clamp();
    }

    clamp() {
      const m = 200;
      this.x = U.clamp(this.x, -m, TM.CONFIG.WORLD_W + m);
      this.y = U.clamp(this.y, -m, TM.CONFIG.WORLD_H + m);
    }

    // The heart of the battle: soldiers in the fight or about to be (before the lines meet: every
    // soldier in the ranks). Percentiles leave out a few far stragglers and lone riders.
    actionRect(B) {
      const xs = this.xs || (this.xs = []), ys = this.ys || (this.ys = []);
      const ax = this.axs || (this.axs = []), ay = this.ays || (this.ays = []);
      xs.length = ys.length = ax.length = ay.length = 0;
      for (let t = 0; t < 2; t++) {
        for (const u of B.alive[t]) {
          if (u.fleeing) continue;
          ax.push(u.x); ay.push(u.y);
          if (u.nearEnemyD < 170 || B.time - u.contactT < 1.5) { xs.push(u.x); ys.push(u.y); }
        }
      }
      if (!ax.length) return null;
      let X = xs, Y = ys, pad = 90;
      if (xs.length < Math.max(6, ax.length * 0.06)) { X = ax; Y = ay; pad = 70; }
      X.sort((a, b) => a - b); Y.sort((a, b) => a - b);
      const q = (A, f) => A[Math.min(A.length - 1, Math.max(0, Math.round((A.length - 1) * f)))];
      return { x0: q(X, 0.03) - pad, y0: q(Y, 0.03) - pad, x1: q(X, 0.97) + pad, y1: q(Y, 0.97) + pad };
    }

    update(dt, B, vw, vh) {
      this.moving = false;
      if (this.anim) {
        const a = this.anim;
        a.t += dt;
        const e = smooth(Math.min(1, a.t / a.dur));
        this.x = a.x0 + (a.x1 - a.x0) * e;
        this.y = a.y0 + (a.y1 - a.y0) * e;
        this.zoom = Math.exp(Math.log(a.z0) + (Math.log(a.z1) - Math.log(a.z0)) * e);
        if (a.t >= a.dur) this.anim = null; else this.moving = true;
        this.clamp();
        return;
      }
      if (this.glide) {
        const g = this.glide, k = 1 - Math.exp(-14 * dt);
        const next = Math.exp(Math.log(this.zoom) + (Math.log(g.z) - Math.log(this.zoom)) * k);
        this.moving = true;
        if (Math.abs(Math.log(next / g.z)) < 0.004) { this.zoomAt(g.sx, g.sy, g.z / this.zoom, g.vw, g.vh); this.glide = null; this.moving = false; }
        else this.zoomAt(g.sx, g.sy, next / this.zoom, g.vw, g.vh);
      }
      if (this.followReg) {
        const R = this.followReg;
        if (!R.alive) this.followReg = null;
        else {
          const k = 1 - Math.exp(-2.5 * dt);
          this.x += ((R.n ? R.cx : R.fcx) - this.x) * k;
          this.y += ((R.n ? R.cy : R.fcy) - this.y) * k;
          return;
        }
      }
      if (this.follow) {
        if (this.follow.state !== TM.Units.ALIVE) { this.follow = null; return; }
        const k = 1 - Math.exp(-6 * dt);
        this.x += (this.follow.x - this.x) * k;
        this.y += (this.follow.y - this.y) * k;
        return;
      }
      if (!this.auto || this.glide) return;
      // auto-director: re-aims a few times a second, then eases there; the zoom stays continuous up
      // to 1 device px per world unit, and moves in to the crisp 2x level only when the fight is
      // compact for a while (and back out with some hysteresis), so it never pumps
      this.aimT -= dt;
      if (this.aimT <= 0 || !this.aim) {
        this.aimT = 0.25;
        const r = this.actionRect(B);
        if (r) {
          const ins = { l: 20, r: 20, t: 92, b: 76 };
          const D = Math.min((vw - ins.l - ins.r) / (r.x1 - r.x0), (vh - ins.t - ins.b) / (r.y1 - r.y0)) * this.dpr;
          const prev = this.aim ? this.aim.z * this.dpr : this.zoom * this.dpr;
          this.closeT = D >= 2.15 ? this.closeT + 0.25 : 0;
          let tD = Math.min(1, U.clamp(D, 0.3 * this.dpr, 1));
          if ((prev >= 1.99 && D >= 1.8) || this.closeT >= 1.5) tD = 2;
          if (tD < 1.99 && prev < 1.99 && Math.abs(tD / prev - 1) < 0.08) tD = prev; // ignore small changes
          const z = tD / this.dpr;
          this.aim = { x: (r.x0 + r.x1) / 2 - (ins.l - ins.r) / 2 / z, y: (r.y0 + r.y1) / 2 - (ins.t - ins.b) / 2 / z, z };
        }
      }
      if (!this.aim) return;
      const kp = 1 - Math.exp(-1.5 * dt), kz = 1 - Math.exp(-1.1 * dt);
      this.x += (this.aim.x - this.x) * kp;
      this.y += (this.aim.y - this.y) * kp;
      const lz = Math.log(this.zoom), la = Math.log(this.aim.z);
      if (Math.abs(la - lz) < 0.003) this.zoom = this.aim.z;
      else { this.zoom = Math.exp(lz + (la - lz) * kz); this.moving = this.zoom * this.dpr > 0.999; }
    }
  }

  TM.Camera = Camera;
})(window.TM = window.TM || {});
