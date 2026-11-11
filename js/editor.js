// Pre-battle army editor: hand-placed groups ("отряды").
//
// Data (lives inside the setup, persisted with it):
//   army.formation === 'manual'  ->  army.groups = [{ id, type, count, cols, shape, angle, x, y }]
//   shape: 'block' (ranks, `cols` men wide) | 'crowd' (loose ellipse)
//   angle: direction the group faces, radians (0 = right). x, y: centre in world units.
// The battle only sees spawn spots (TM.Formations.spawn), so AI / combat are untouched.
// While in the editor the field shows the real preview battle plus group outlines.
(function (TM) {
  'use strict';
  const C = TM.CONFIG;
  const $ = (id) => document.getElementById(id);
  const SHORT = { sword: 'Меч', spear: 'Коп', archer: 'Лук', knight: 'Рыц', giant: 'Вел' };

  function strHash(s) { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
  function hash(a, b) {
    let h = (a * 374761393 + b * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const defAngle = (t) => (TM.TEAMS[t].dir > 0 ? 0 : Math.PI);
  let seq = 0;
  const newId = () => 'g' + Date.now().toString(36) + (seq++).toString(36);

  // ------------------------------------------------------------------ group geometry
  const Groups = {
    dims(g) {
      const D = TM.Formations.spacing(g.type), n = g.count;
      if (g.shape === 'crowd') { const R = D * Math.sqrt(n) * 0.58 + D * 0.4; return { D, R, w: R * 2, d: R * 2 }; }
      const cols = clamp(g.cols | 0, 1, n), rows = Math.ceil(n / cols);
      return { D, cols, rows, w: cols * D, d: rows * D };
    },

    // Spawn spots of one group (appended to `out`). Deterministic: no RNG, so previews don't shimmer.
    layout(g, out) {
      const n = g.count | 0;
      if (n <= 0) return out;
      const dm = this.dims(g), D = dm.D, a = g.angle || 0;
      const fx = Math.cos(a), fy = Math.sin(a), px = -fy, py = fx;
      const gh = strHash(g.id || 'g');
      const W = C.WORLD_W, H = C.WORLD_H;
      for (let i = 0; i < n; i++) {
        let dep, lat;
        if (g.shape === 'crowd') {
          const r = dm.R * Math.sqrt((i + 0.5) / n), th = i * 2.39996 + (gh % 628) / 100;
          dep = r * Math.cos(th); lat = r * Math.sin(th);
        } else {
          const row = (i / dm.cols) | 0, col = i - row * dm.cols;
          const rowN = Math.min(dm.cols, n - row * dm.cols);
          lat = (col - (rowN - 1) / 2) * D + (row & 1) * D * 0.3;
          dep = ((dm.rows - 1) / 2 - row) * D; // row 0 = front rank
        }
        dep += (hash(gh + i, 1) - 0.5) * 2.4; lat += (hash(gh + i, 2) - 0.5) * 2.4;
        out.push({
          type: g.type, angle: a,
          x: clamp(g.x + fx * dep + px * lat, 24, W - 24),
          y: clamp(g.y + fy * dep + py * lat, 24, H - 24),
        });
      }
      return out;
    },

    contains(g, x, y, pad) {
      const dm = this.dims(g), a = g.angle || 0;
      const dx = x - g.x, dy = y - g.y;
      if (g.shape === 'crowd') return Math.hypot(dx, dy) <= dm.R + pad;
      const lf = dx * Math.cos(a) + dy * Math.sin(a), lp = -dx * Math.sin(a) + dy * Math.cos(a);
      return Math.abs(lf) <= dm.d / 2 + pad && Math.abs(lp) <= dm.w / 2 + pad;
    },

    // 4 world-space corners [x0,y0,...] of the footprint (crowd: its bounding square)
    corners(g) {
      const dm = this.dims(g), a = g.angle || 0;
      const fx = Math.cos(a), fy = Math.sin(a), hd = dm.d / 2, hw = dm.w / 2;
      const pts = [];
      for (const [sf, sp] of [[1, -1], [1, 1], [-1, 1], [-1, -1]]) {
        pts.push(g.x + fx * hd * sf - fy * hw * sp, g.y + fy * hd * sf + fx * hw * sp);
      }
      return pts;
    },

    counts(army) {
      if (army.formation !== 'manual') return army.counts;
      const c = {};
      for (const k of TM.UNIT_ORDER) c[k] = 0;
      for (const g of army.groups || []) c[g.type] += g.count | 0;
      return c;
    },

    total(army) { const c = this.counts(army); let s = 0; for (const k of TM.UNIT_ORDER) s += c[k] | 0; return s; },

    // Turn an automatic layout into editable groups (one per class and contiguous cluster).
    fromAuto(team, army) {
      const form = army.formation === 'manual' ? 'line' : army.formation;
      const spots = TM.Formations.generate(team, army.counts, form);
      const out = [];
      for (const type of TM.UNIT_ORDER) {
        const list = spots.filter((s) => s.type === type).sort((a, b) => a.y - b.y);
        if (!list.length) continue;
        const D = TM.Formations.spacing(type);
        let start = 0;
        for (let i = 1; i <= list.length; i++) {
          if (i < list.length && list[i].y - list[i - 1].y <= D * 2.4) continue;
          const cl = list.slice(start, i); start = i;
          let sx = 0, sy = 0;
          for (const s of cl) { sx += s.x; sy += s.y; }
          const span = cl[cl.length - 1].y - cl[0].y;
          out.push({
            id: newId(), type, count: cl.length,
            cols: clamp(Math.round(span / D) + 1, 1, cl.length),
            shape: form === 'horde' ? 'crowd' : 'block',
            angle: defAngle(team), x: Math.round(sx / cl.length), y: Math.round(sy / cl.length),
          });
        }
      }
      return out;
    },

    // 180° rotation about the field centre, like the automatic mirrored layouts
    mirror(groups) {
      return groups.map((g) => Object.assign({}, g, {
        id: newId(), x: C.WORLD_W - g.x, y: C.WORLD_H - g.y, angle: ((g.angle || 0) + Math.PI) % (Math.PI * 2),
      }));
    },

    // Validate groups loaded from storage.
    sanitize(army) {
      const ok = [];
      for (const g of Array.isArray(army.groups) ? army.groups : []) {
        const d = TM.UNIT_TYPES[g && g.type];
        if (!d) continue;
        ok.push({
          id: g.id || newId(), type: g.type,
          count: clamp(g.count | 0, 1, d.max), cols: clamp(g.cols | 0 || 6, 1, 60),
          shape: g.shape === 'crowd' ? 'crowd' : 'block', angle: +g.angle || 0,
          x: clamp(+g.x || C.WORLD_W / 2, 0, C.WORLD_W), y: clamp(+g.y || C.WORLD_H / 2, 0, C.WORLD_H),
        });
      }
      army.groups = ok;
    },
  };

  // ------------------------------------------------------------------ editor controller
  const Editor = {
    game: null,
    brush: { type: 'sword', count: 30, cols: 6, shape: 'block', angle: 0 },
    armed: -1,          // team currently placing groups (-1 = none)
    sel: null,          // { t, id }
    hover: null,        // { t, g } under the cursor
    ghost: null,        // cursor world position while placing
    drag: null,
    cv: null,

    init(game) {
      this.game = game;
      this.cv = $('view');
      for (let t = 0; t < 2; t++) this.buildPanel(t);
    },

    army(t) { return this.game.setup.armies[t]; },
    groups(t) { const a = this.army(t); return a.groups || (a.groups = []); },
    selGroup() {
      if (!this.sel) return null;
      return this.groups(this.sel.t).find((g) => g.id === this.sel.id) || (this.sel = null);
    },
    target(t) { return this.sel && this.sel.t === t && this.selGroup() ? this.selGroup() : this.brush; },
    changed() { this.game.setupChanged({ keepView: true }); this.sync(); },

    // ---------------- panel ----------------
    buildPanel(t) {
      const el = document.createElement('div');
      el.className = 'ed';
      el.id = 'ed-' + t;
      let types = '';
      for (const k of TM.UNIT_ORDER) {
        types += `<button class="ed-type" data-type="${k}" title="${TM.UNIT_TYPES[k].name}"><canvas width="64" height="64" data-icon="${k}"></canvas><span>${SHORT[k]}</span></button>`;
      }
      el.innerHTML = `
        <div class="ed-status" id="ed-status-${t}"></div>
        <button class="ed-place" data-act="place"></button>
        <div class="ed-sub" id="ed-sub-${t}"></div>
        <div class="ed-types">${types}</div>
        <div class="ed-ctrl"><span>Бойцов</span><input type="range" data-f="count" min="1" max="200"><input type="number" data-f="count" min="1"></div>
        <div class="ed-ctrl" data-row="cols"><span>В шеренге</span><input type="range" data-f="cols" min="1" max="40"><input type="number" data-f="cols" min="1" max="60"></div>
        <div class="ed-ctrl"><span>Форма</span><div class="ed-seg"><button data-shape="block">Строй</button><button data-shape="crowd">Толпа</button></div></div>
        <div class="ed-ctrl"><span>Поворот</span><input type="range" data-f="angle" min="0" max="345" step="15"><b class="ed-deg" id="ed-deg-${t}"></b></div>
        <div class="ed-selbtns" id="ed-selbtns-${t}"><button data-act="dup">⧉ Копия</button><button data-act="del" class="danger">✕ Удалить</button></div>
        <div class="ed-list" id="ed-list-${t}"></div>
        <div class="ed-hint">Правая кнопка по отряду — удалить · <kbd>Q</kbd>/<kbd>E</kbd> — повернуть · <kbd>Del</kbd> — удалить · <kbd>F</kbd> — показать всё поле</div>`;
      const panel = $('panel-' + t);
      panel.querySelector('.section-label').before(el);
      el.querySelectorAll('canvas[data-icon]').forEach((c) => TM.Render.drawIcon(c, c.dataset.icon, t));

      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const tg = this.target(t);
        if (b.dataset.type) {
          tg.type = b.dataset.type;
          tg.count = Math.min(tg.count, TM.UNIT_TYPES[tg.type].max);
          this.changed();
        } else if (b.dataset.shape) { tg.shape = b.dataset.shape; this.changed(); }
        else if (b.dataset.act === 'place') { this.armed === t ? this.disarm() : this.arm(t); }
        else if (b.dataset.act === 'del') this.remove(t, this.sel && this.sel.id);
        else if (b.dataset.act === 'dup') this.duplicate();
        else if (b.dataset.del) this.remove(t, b.dataset.del);
      });
      el.querySelector('.ed-list').addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const row = e.target.closest('.ed-g');
        if (row) this.select(t, row.dataset.id, true);
      });
      el.addEventListener('input', (e) => {
        const f = e.target.dataset.f;
        if (!f) return;
        const tg = this.target(t);
        let v = +e.target.value || 0;
        if (f === 'count') v = clamp(Math.round(v), 1, TM.UNIT_TYPES[tg.type].max);
        else if (f === 'cols') v = clamp(Math.round(v), 1, 60);
        else v = (v % 360) * Math.PI / 180;
        tg[f] = v;
        this.changed();
      });
    },

    // ---------------- state changes ----------------
    arm(t) {
      if (this.brush.team !== t) { this.brush.angle = defAngle(t); this.brush.team = t; }
      this.armed = t; this.sel = null; this.sync();
    },
    disarm() { this.armed = -1; this.ghost = null; this.sync(); },
    select(t, id) {
      this.sel = { t, id }; this.armed = -1; this.ghost = null;
      this.sync();
    },
    remove(t, id) {
      if (!id) return;
      const gs = this.groups(t), i = gs.findIndex((g) => g.id === id);
      if (i < 0) return;
      gs.splice(i, 1);
      if (this.sel && this.sel.id === id) this.sel = null;
      this.hover = null;
      this.changed();
    },
    duplicate() {
      const g = this.selGroup();
      if (!g) return;
      const c = Object.assign({}, g, { id: newId(), x: clamp(g.x + 40, 0, C.WORLD_W), y: clamp(g.y + 40, 0, C.WORLD_H) });
      this.groups(this.sel.t).push(c);
      this.sel = { t: this.sel.t, id: c.id };
      this.changed();
    },
    place(t, w) {
      const b = this.brush;
      const g = { id: newId(), type: b.type, count: b.count, cols: b.cols, shape: b.shape, angle: b.angle, x: clamp(Math.round(w.x), 0, C.WORLD_W), y: clamp(Math.round(w.y), 0, C.WORLD_H) };
      this.groups(t).push(g);
      this.changed();
    },

    // Called by the game when an army's formation button is pressed.
    onFormation(t, key) {
      const army = this.army(t);
      if (key === 'manual' && army.formation !== 'manual' && !(army.groups && army.groups.length)) {
        army.groups = Groups.fromAuto(t, army); // start from what is currently on the field
      }
      if (key !== 'manual') { if (this.armed === t) this.armed = -1; if (this.sel && this.sel.t === t) this.sel = null; }
    },
    // "Как у врага" / "Очистить" for manual armies. Returns true when handled here.
    mirrorEnemy(t) {
      const other = this.army(1 - t), army = this.army(t);
      if (other.formation !== 'manual' && army.formation !== 'manual') return false;
      const src = other.formation === 'manual' ? other.groups || [] : Groups.fromAuto(1 - t, other);
      army.groups = Groups.mirror(src);
      army.formation = 'manual';
      this.sel = null;
      return true;
    },
    clear(t) {
      const army = this.army(t);
      if (army.formation !== 'manual') return false;
      army.groups = [];
      if (this.sel && this.sel.t === t) this.sel = null;
      return true;
    },

    // ---------------- panel sync ----------------
    sync() {
      if (!this.game) return;
      for (let t = 0; t < 2; t++) {
        const el = $('ed-' + t), army = this.army(t);
        if (!el) continue;
        const manual = army.formation === 'manual';
        $('panel-' + t).classList.toggle('is-manual', manual);
        if (!manual) continue;
        const tg = this.target(t), isSel = tg !== this.brush;
        const d = TM.UNIT_TYPES[tg.type];
        $('ed-status-' + t).innerHTML = isSel
          ? `Выбран отряд: <b>${d.name} ×${tg.count}</b>`
          : this.armed === t ? 'Режим установки: клик по полю ставит отряд. <b>Esc</b> или правая кнопка — выйти.' : 'Нажмите «Поставить» и кликайте по полю, или кликните по готовому отряду, чтобы изменить его.';
        $('ed-sub-' + t).textContent = isSel ? 'Параметры выбранного отряда' : 'Параметры нового отряда';
        const pb = el.querySelector('[data-act=place]');
        pb.textContent = this.armed === t ? '✔ Ставлю отряды (клик по полю)' : '＋ Поставить отряд на поле';
        pb.classList.toggle('on', this.armed === t);
        el.querySelectorAll('.ed-type').forEach((b) => b.classList.toggle('on', b.dataset.type === tg.type));
        el.querySelectorAll('[data-shape]').forEach((b) => b.classList.toggle('on', b.dataset.shape === tg.shape));
        const setv = (f, v, max) => el.querySelectorAll(`[data-f=${f}]`).forEach((i) => {
          if (document.activeElement !== i) i.value = v;
          if (max) i.max = i.type === 'range' ? Math.min(max, 200) : max;
        });
        setv('count', tg.count, d.max);
        setv('cols', tg.cols);
        setv('angle', Math.round(((tg.angle * 180 / Math.PI) % 360 + 360) % 360 / 15) * 15 % 360);
        $('ed-deg-' + t).textContent = Math.round(((tg.angle * 180 / Math.PI) % 360 + 360) % 360) + '°';
        el.querySelector('[data-row=cols]').classList.toggle('off', tg.shape === 'crowd');
        $('ed-selbtns-' + t).style.display = isSel ? '' : 'none';
        const gs = this.groups(t);
        let tot = 0, html = '';
        for (const g of gs) {
          tot += g.count;
          html += `<div class="ed-g${this.sel && this.sel.id === g.id ? ' sel' : ''}" data-id="${g.id}"><b>${TM.UNIT_TYPES[g.type].name}</b> ×${g.count}<small>${g.shape === 'crowd' ? 'толпа' : g.cols + ' в шеренге'}</small><button data-del="${g.id}" title="Удалить отряд">✕</button></div>`;
        }
        $('ed-list-' + t).innerHTML = gs.length ? `<div class="ed-listhead">Отрядов: ${gs.length} · бойцов: ${tot}</div>` + html : '<div class="ed-empty">Отрядов пока нет</div>';
      }
      if (TM.UI && TM.UI.updateTotals) TM.UI.updateTotals();
    },

    // ---------------- field interaction ----------------
    pick(w) {
      const pad = Math.max(4, 6 / this.game.cam.view());
      const order = [];
      for (let t = 0; t < 2; t++) if (this.army(t).formation === 'manual') for (const g of this.groups(t)) order.push({ t, g });
      const sel = this.selGroup();
      if (sel && Groups.contains(sel, w.x, w.y, pad)) return { t: this.sel.t, g: sel };
      // later groups are drawn on top: the last one under the cursor wins
      for (let i = order.length - 1; i >= 0; i--) if (Groups.contains(order[i].g, w.x, w.y, pad)) return order[i];
      return null;
    },
    anyManual() { return this.army(0).formation === 'manual' || this.army(1).formation === 'manual'; },

    hoverAt(w) {
      this.ghost = this.armed >= 0 ? w : null;
      this.hover = this.anyManual() ? this.pick(w) : null;
      this.cv.classList.toggle('placing', this.armed >= 0 && !this.hover);
      this.cv.classList.toggle('over-group', !!this.hover);
    },
    // returns true if the press was captured (group grabbed) so the camera must not pan
    down(w) {
      const h = this.anyManual() ? this.pick(w) : null;
      if (!h) return false;
      this.select(h.t, h.g.id);
      this.drag = { dx: h.g.x - w.x, dy: h.g.y - w.y };
      return true;
    },
    dragTo(w) {
      const g = this.selGroup();
      if (!g || !this.drag) return;
      g.x = clamp(Math.round(w.x + this.drag.dx), 0, C.WORLD_W);
      g.y = clamp(Math.round(w.y + this.drag.dy), 0, C.WORLD_H);
      this.game.setupChanged({ keepView: true });
    },
    up() { if (this.drag) { this.drag = null; this.sync(); } },
    // plain click on the field (no drag, nothing grabbed)
    click(w) {
      if (this.armed >= 0) this.place(this.armed, w);
      else if (this.sel) { this.sel = null; this.sync(); }
    },
    rightClick(w) {
      const h = this.anyManual() ? this.pick(w) : null;
      if (h) this.remove(h.t, h.g.id);
      else if (this.armed >= 0) this.disarm();
    },
    // returns true if the key was consumed
    key(e) {
      if (!this.anyManual()) return false;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' && (e.target.type === 'number' || e.target.type === 'text')) return false;
      if (e.code === 'Delete' || e.code === 'Backspace') { if (this.sel) { this.remove(this.sel.t, this.sel.id); return true; } return false; }
      if (e.code === 'Escape') {
        if (this.armed >= 0) { this.disarm(); return true; }
        if (this.sel) { this.sel = null; this.sync(); return true; }
        return false;
      }
      if (e.code === 'KeyQ' || e.code === 'KeyE') {
        const t = this.sel ? this.sel.t : this.armed >= 0 ? this.armed : 0;
        const tg = this.target(t);
        tg.angle = (tg.angle + (e.code === 'KeyE' ? 1 : -1) * Math.PI / 12 + Math.PI * 2) % (Math.PI * 2);
        this.changed();
        return true;
      }
      return false;
    },

    // ---------------- overlay (drawn by the renderer, setup mode only) ----------------
    draw(ctx, D, ox, oy, n) {
      if (!this.game || !this.anyManual()) return;
      const S = TM.Sprites, lw = Math.max(1, D >= 1 ? n : 1);
      const toS = (x, y) => [Math.round(x * D + ox), Math.round(y * D + oy)];
      const outline = (g, t, style) => {
        const T = TM.TEAMS[t];
        ctx.lineWidth = style === 'sel' ? lw * 2 : lw;
        ctx.strokeStyle = style === 'sel' ? '#ffd34d' : style === 'hover' ? '#ffffff' : T.light;
        ctx.fillStyle = style === 'sel' ? 'rgba(255,211,77,0.12)' : style === 'ghost' ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)';
        ctx.setLineDash(style === 'ghost' ? [6 * lw, 4 * lw] : []);
        ctx.beginPath();
        if (g.shape === 'crowd') { const [cx, cy] = toS(g.x, g.y); ctx.arc(cx, cy, Groups.dims(g).R * D, 0, Math.PI * 2); }
        else {
          const c = Groups.corners(g);
          const p0 = toS(c[0], c[1]); ctx.moveTo(p0[0], p0[1]);
          for (let i = 2; i < 8; i += 2) { const p = toS(c[i], c[i + 1]); ctx.lineTo(p[0], p[1]); }
          ctx.closePath();
        }
        ctx.fill(); ctx.stroke();
        ctx.setLineDash([]);
        // facing arrow from the centre to the front edge
        const a = g.angle || 0, len = Groups.dims(g).d / 2 + 6;
        const [x0, y0] = toS(g.x, g.y), [x1, y1] = toS(g.x + Math.cos(a) * len, g.y + Math.sin(a) * len);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        const ah = 5 * lw, ca = Math.cos(a), sa = Math.sin(a);
        ctx.lineTo(x1 - ca * ah - sa * ah * 0.6, y1 - sa * ah + ca * ah * 0.6);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ca * ah + sa * ah * 0.6, y1 - sa * ah - ca * ah * 0.6);
        ctx.stroke();
        // label above the footprint
        const lab = `${SHORT[g.type]} ×${g.count}`;
        const cv = S.text(lab, style === 'sel' ? '#ffd34d' : '#ffffff');
        const k = D >= 1 ? Math.max(1, Math.round(n / 2)) : 1;
        let top = g.y - Groups.dims(g).R;
        if (g.shape !== 'crowd') { const c = Groups.corners(g); top = Math.min(c[1], c[3], c[5], c[7]); }
        const [lx, ly] = toS(g.x, top);
        ctx.drawImage(cv, lx - ((cv.width * k) >> 1), ly - cv.height * k - 2, cv.width * k, cv.height * k);
      };
      for (let t = 0; t < 2; t++) {
        if (this.army(t).formation !== 'manual') continue;
        for (const g of this.groups(t)) {
          const isSel = this.sel && this.sel.id === g.id;
          const isHov = this.hover && this.hover.g === g;
          outline(g, t, isSel ? 'sel' : isHov ? 'hover' : 'norm');
        }
      }
      if (this.armed >= 0 && this.ghost) {
        const b = this.brush;
        outline({ type: b.type, count: b.count, cols: b.cols, shape: b.shape, angle: b.angle, x: this.ghost.x, y: this.ghost.y }, this.armed, 'ghost');
      }
    },
  };

  TM.Groups = Groups;
  TM.Editor = Editor;
})(window.TM = window.TM || {});
