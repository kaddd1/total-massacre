// Camera: pan / zoom-to-cursor / fit / auto-follow the action / follow a unit.
(function (TM) {
  'use strict';
  const U = TM.U;

  class Camera {
    constructor() {
      this.x = TM.CONFIG.WORLD_W / 2;
      this.y = TM.CONFIG.WORLD_H / 2;
      this.zoom = 0.5;
      this.minZoom = 0.2;
      this.maxZoom = 5;
      this.auto = false;
      this.follow = null;
      this.dpr = 1;
      this.ez = this.zoom;
      this.wheelAcc = 0;
    }

    // Effective zoom actually used for drawing. When a world unit covers >= 1 device
    // pixel, zoom snaps to integer device-pixel levels so pixel art stays crisp.
    view() {
      const D = this.zoom * this.dpr;
      this.ez = D >= 0.999 ? Math.max(1, Math.round(D)) / this.dpr : this.zoom;
      return this.ez;
    }

    // One zoom "notch": continuous below 1 device px / unit, integer levels above.
    stepZoom(dir, sx, sy, vw, vh) {
      const D = this.zoom * this.dpr;
      let nD;
      if (D < 0.999) { nD = D * (dir > 0 ? 1.2 : 1 / 1.2); if (nD > 1) nD = 1; }
      else { nD = Math.round(D) + dir; if (nD < 1) nD = 0.85; }
      this.zoomAt(sx, sy, nD / D, vw, vh);
    }

    wheel(dy, sx, sy, vw, vh) {
      const D = this.zoom * this.dpr, f = Math.exp(-dy * 0.0015);
      if (D < 0.999 && D * f < 0.999) { this.wheelAcc = 0; this.zoomAt(sx, sy, f, vw, vh); return; }
      this.wheelAcc += dy;
      if (Math.abs(this.wheelAcc) < 60) return;
      const dir = this.wheelAcc < 0 ? 1 : -1;
      this.wheelAcc = 0;
      this.stepZoom(dir, sx, sy, vw, vh);
    }

    // Frames `rect` inside the screen area left free by UI insets {l, r, t, b}.
    fit(vw, vh, rect, ins) {
      const r = rect || { x0: 0, y0: 0, x1: TM.CONFIG.WORLD_W, y1: TM.CONFIG.WORLD_H };
      const i = ins || { l: 0, r: 0, t: 0, b: 0 };
      const aw = Math.max(200, vw - i.l - i.r), ah = Math.max(150, vh - i.t - i.b);
      this.zoom = U.clamp(Math.min(aw / (r.x1 - r.x0), ah / (r.y1 - r.y0)), this.minZoom, this.maxZoom);
      if (this.zoom * this.dpr >= 1) this.zoom = Math.floor(this.zoom * this.dpr) / this.dpr; // whole content must fit
      const z = this.view();
      this.x = (r.x0 + r.x1) / 2 - (i.l - i.r) / 2 / z;
      this.y = (r.y0 + r.y1) / 2 - (i.t - i.b) / 2 / z;
    }

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

    // Bounding box of the fighting units (ignores routing stragglers).
    actionRect(B) {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, n = 0;
      for (let t = 0; t < 2; t++) {
        for (const u of B.alive[t]) {
          if (u.fleeing) continue;
          if (u.x < x0) x0 = u.x; if (u.x > x1) x1 = u.x;
          if (u.y < y0) y0 = u.y; if (u.y > y1) y1 = u.y;
          n++;
        }
      }
      if (!n) return null;
      const pad = 80;
      return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
    }

    update(dt, B, vw, vh) {
      if (this.follow) {
        if (this.follow.state !== TM.Units.ALIVE) { this.follow = null; return; }
        const k = 1 - Math.exp(-6 * dt);
        this.x += (this.follow.x - this.x) * k;
        this.y += (this.follow.y - this.y) * k;
        return;
      }
      if (!this.auto) return;
      const r = this.actionRect(B);
      if (!r) return;
      const tz = U.clamp(Math.min(vw / (r.x1 - r.x0), vh / (r.y1 - r.y0)), 0.3, 2.2);
      const k = 1 - Math.exp(-1.6 * dt);
      this.x += ((r.x0 + r.x1) / 2 - this.x) * k;
      this.y += ((r.y0 + r.y1) / 2 - this.y) * k;
      this.zoom += (tz - this.zoom) * k;
    }
  }

  TM.Camera = Camera;
})(window.TM = window.TM || {});
