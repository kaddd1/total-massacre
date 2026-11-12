// DOM user interface: army setup panels, presets, HUD, kill feed, tooltip, results.
(function (TM) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
  const SHORT = { sword: 'Меч', spear: 'Коп', archer: 'Лук', knight: 'Рыц', giant: 'Вел' };
  const CHART_COL = ['#e5544a', '#4a8fee'];

  const UI = {
    game: null,
    inputs: [{}, {}],
    feedSeen: 0,
    lastHud: 0,

    init(game) {
      this.game = game;
      for (let t = 0; t < 2; t++) this.buildPanel(t);
      this.buildPresets();
      this.buildSpeeds();

      $('opt-morale').addEventListener('change', (e) => { game.setup.morale = e.target.checked; game.setupChanged(); });
      $('opt-ff').addEventListener('change', (e) => { game.setup.friendlyFire = e.target.checked; game.setupChanged(); });
      $('btn-start').addEventListener('click', () => game.start());
      $('btn-pause').addEventListener('click', () => game.togglePause());
      $('btn-auto').addEventListener('click', () => game.toggleAuto());
      $('btn-cine').addEventListener('click', () => game.toggleCine());
      $('btn-fit').addEventListener('click', () => game.fit());
      $('btn-tac').addEventListener('click', () => game.toggleTactics());
      $('btn-restart').addEventListener('click', () => game.restart());
      $('btn-new').addEventListener('click', () => game.toSetup());
      $('btn-help').addEventListener('click', () => this.toggleHelp());
      document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('.modal').classList.add('hidden')));
      TM.Editor.init(game);
      TM.Audio.bindUI();
      this.initMinimap();
      this.syncFromSetup();
    },

    // ---------------- army panel ----------------
    buildPanel(t) {
      const team = TM.TEAMS[t];
      const el = $('panel-' + t);
      let html = `<div class="panel-head"><h2>${team.full}</h2><div class="panel-total"><b id="total-${t}">0</b> бойцов</div></div>`;
      for (const key of TM.UNIT_ORDER) {
        const d = TM.UNIT_TYPES[key];
        const range = d.ranged ? d.ranged.range : d.reach;
        const dmg = d.ranged ? `${d.ranged.dmgMin}–${d.ranged.dmgMax}` : `${d.dmgMin}–${d.dmgMax}`;
        html += `
        <div class="unit-row" id="row-${t}-${key}" title="${d.desc}">
          <canvas class="unit-icon" width="96" height="96" data-icon="${key}"></canvas>
          <div class="unit-body">
            <div class="unit-title"><span class="unit-name">${d.name}</span></div>
            <div class="unit-stats">HP ${d.hp} · урон ${dmg} · дист ${range} · скор ${d.speed}</div>
            <div class="unit-ctrl">
              <button class="step-btn" data-step="-10">−</button>
              <input type="range" min="0" max="${d.max}" step="1" data-k="${key}">
              <button class="step-btn" data-step="10">+</button>
              <input type="number" min="0" max="${d.max}" data-k="${key}">
            </div>
          </div>
        </div>`;
      }
      html += `<div class="section-label">Построение</div><div class="seg" id="form-${t}">`;
      for (const f of TM.FORMATIONS) html += `<button data-f="${f.key}" title="${f.desc}">${f.name}</button>`;
      html += `</div><div class="formation-desc" id="form-desc-${t}"></div>`;
      html += `<div class="panel-actions">
        <button data-act="random" title="Случайный состав">Случайно</button>
        <button data-act="clear" title="Убрать всех">Очистить</button>
        <button data-act="mirror" title="Скопировать армию противника">Как у врага</button>
      </div>`;
      el.innerHTML = html;

      el.querySelectorAll('canvas[data-icon]').forEach((c) => TM.Render.drawIcon(c, c.dataset.icon, t));

      for (const key of TM.UNIT_ORDER) {
        const row = $(`row-${t}-${key}`);
        const range = row.querySelector('input[type=range]');
        const num = row.querySelector('input[type=number]');
        this.inputs[t][key] = { range, num, row };
        const set = (v) => {
          const d = TM.UNIT_TYPES[key];
          v = Math.max(0, Math.min(d.max, Math.round(+v || 0)));
          this.game.setup.armies[t].counts[key] = v;
          range.value = v; num.value = v;
          row.classList.toggle('zero', v === 0);
          this.updateTotals();
          this.game.setupChanged();
        };
        range.addEventListener('input', () => set(range.value));
        num.addEventListener('change', () => set(num.value));
        row.querySelectorAll('.step-btn').forEach((b) => b.addEventListener('click', () => set(+range.value + +b.dataset.step)));
      }
      el.querySelectorAll(`#form-${t} button`).forEach((b) => b.addEventListener('click', () => {
        TM.Editor.onFormation(t, b.dataset.f);
        this.game.setup.armies[t].formation = b.dataset.f;
        this.syncFromSetup();
        this.game.setupChanged();
      }));
      el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
        const army = this.game.setup.armies[t];
        if (b.dataset.act === 'random') Object.assign(army, UI.randomArmy());
        else if (b.dataset.act === 'clear') { if (!TM.Editor.clear(t)) for (const k of TM.UNIT_ORDER) army.counts[k] = 0; }
        else if (b.dataset.act === 'mirror' && TM.Editor.mirrorEnemy(t)) { /* manual groups mirrored */ }
        else if (b.dataset.act === 'mirror') {
          const other = this.game.setup.armies[1 - t];
          army.counts = Object.assign({}, other.counts);
          army.formation = other.formation;
        }
        this.syncFromSetup();
        this.game.setupChanged();
      }));
    },

    randomArmy() {
      const R = Math.random;
      const lim = { sword: 220, spear: 160, archer: 160, knight: 50, giant: 5 };
      const counts = {};
      let any = 0;
      for (const k of TM.UNIT_ORDER) {
        const on = R() < (k === 'giant' ? 0.3 : 0.75);
        counts[k] = on ? Math.round(lim[k] * (0.15 + R() * 0.85)) : 0;
        any += counts[k];
      }
      if (!any) counts.sword = 80;
      const auto = TM.FORMATIONS.filter((f) => f.key !== 'manual');
      return { counts, formation: auto[(R() * auto.length) | 0].key };
    },

    syncFromSetup() {
      const s = this.game.setup;
      for (let t = 0; t < 2; t++) {
        const army = s.armies[t];
        for (const key of TM.UNIT_ORDER) {
          const v = army.counts[key] | 0;
          const inp = this.inputs[t][key];
          inp.range.value = v; inp.num.value = v;
          inp.row.classList.toggle('zero', v === 0);
        }
        document.querySelectorAll(`#form-${t} button`).forEach((b) => b.classList.toggle('on', b.dataset.f === army.formation));
        const f = TM.FORMATIONS.find((x) => x.key === army.formation);
        $('form-desc-' + t).textContent = f ? f.desc : '';
      }
      $('opt-morale').checked = s.morale !== false;
      $('opt-ff').checked = s.friendlyFire !== false;
      this.updateTotals();
      TM.Editor.sync();
    },

    updateTotals() {
      let total = 0;
      const sums = [0, 0];
      for (let t = 0; t < 2; t++) {
        sums[t] = TM.Groups.total(this.game.setup.armies[t]);
        $('total-' + t).textContent = sums[t];
        total += sums[t];
      }
      const w = $('total-warn');
      if (!sums[0] || !sums[1]) {
        w.textContent = 'В каждой армии должен быть хотя бы один боец';
        w.className = 'warn';
      } else if (total > 2400) {
        w.textContent = `Всего ${total} бойцов — на слабом ПК может притормаживать`;
        w.className = 'warn';
      } else {
        w.textContent = `Всего на поле: ${total}`;
        w.className = '';
      }
      $('btn-start').disabled = !sums[0] || !sums[1];
    },

    buildPresets() {
      const list = $('preset-list');
      TM.PRESETS.forEach((p) => {
        const b = document.createElement('button');
        b.textContent = p.name;
        b.title = p.desc;
        b.addEventListener('click', () => this.game.applyPreset(p));
        list.appendChild(b);
      });
      const r = document.createElement('button');
      r.className = 'rnd';
      r.textContent = '🎲 Случайная битва';
      r.addEventListener('click', () => this.game.applyPreset({ red: this.randomArmy(), blue: this.randomArmy() }));
      list.appendChild(r);
    },

    buildSpeeds() {
      const g = $('speed-group');
      SPEEDS.forEach((s, i) => {
        const b = document.createElement('button');
        b.textContent = s + '×';
        const hk = { 1: '1', 2: '2', 4: '3', 8: '4' }[s];
        b.title = `Скорость ${s}×` + (hk ? ` (клавиша ${hk})` : ' ([ / ])');
        b.dataset.speed = s;
        b.addEventListener('click', () => this.game.setSpeed(s));
        g.appendChild(b);
      });
    },

    // ---------------- modes ----------------
    setMode(mode) {
      $('app').className = 'mode-' + mode;
      if (mode === 'setup') {
        $('result').classList.add('hidden');
        $('feed').innerHTML = '';
      }
      if (this.game.renderer) this.game.renderer.focusEvent = null;
      $('banner').className = '';
      this.feedSeen = 0;
    },

    syncControls() {
      const g = this.game;
      $('btn-pause').textContent = g.paused ? '▶' : '❚❚';
      $('btn-pause').classList.toggle('on', g.paused);
      $('btn-auto').classList.toggle('on', g.cam.auto && !g.cam.cine);
      $('btn-cine').classList.toggle('on', !!g.cam.cine);
      $('btn-tac').classList.toggle('on', !!(g.renderer && g.renderer.showTactics));
      document.querySelectorAll('#speed-group button').forEach((b) => b.classList.toggle('on', +b.dataset.speed === g.speed));
    },

    // ---------------- HUD ----------------
    updateHud(B, force) {
      const now = performance.now();
      if (!force && now - this.lastHud < 100) return;
      this.lastHud = now;
      const g = this.game;
      for (let t = 0; t < 2; t++) {
        const s = B.stats[t];
        $('hud-alive-' + t).textContent = s.alive;
        $('hud-dead-' + t).textContent = s.dead;
        $('hud-fled-' + t).textContent = s.fled;
        $('hud-panic-' + t).textContent = s.fleeing;
        let types = '';
        for (const k of TM.UNIT_ORDER) {
          const bt = s.byType[k];
          if (!bt.deployed) continue;
          types += `<span>${SHORT[k]} <i>${bt.deployed - bt.dead - bt.fled}</i></span>`;
        }
        const el = $('hud-types-' + t);
        if (el._last !== types) { el.innerHTML = types; el._last = types; }
      }
      this.updateChips(B);
      const a0 = B.stats[0].alive, a1 = B.stats[1].alive, sum = a0 + a1 || 1;
      $('bar-0').style.width = (a0 / sum * 100) + '%';
      $('bar-1').style.width = (a1 / sum * 100) + '%';
      $('hud-time').textContent = TM.U.fmtTime(B.duration());
      let st;
      if (B.state === 'deploy') st = 'Расстановка';
      else if (B.winner !== -1) st = B.winner === 2 ? 'Ничья' : 'Победа: ' + TM.TEAMS[B.winner].name;
      else if (g.paused) st = 'Пауза';
      else if (!B.contact[0] && !B.contact[1]) st = 'Сближение';
      else st = 'Бой' + (g.speed !== 1 ? ' · ' + g.speed + '×' : '');
      $('hud-state').textContent = st;

      $('perf').textContent = `${Math.round(g.fps)} FPS · ${B.stats[0].alive + B.stats[1].alive} бойцов · ${g.stepMs.toFixed(1)} мс/кадр сим.`;

      // kill feed
      while (this.feedSeen < B.events.length) {
        const ev = B.events[this.feedSeen++];
        this.pushFeed(ev);
        if (B.time - ev.time < 3) this.bannerFor(ev, B);
      }
    },

    // ---------------- regiment chips ----------------
    buildChips(B) {
      this.chipB = B;
      this.chips = [];
      const g = this.game;
      for (let t = 0; t < 2; t++) {
        const el = $('hud-regs-' + t);
        el.innerHTML = '';
        if (!B.tac) continue;
        const regs = B.tac.regs.filter((r) => r.team === t).sort((a, b) => TM.UNIT_ORDER.indexOf(a.type) - TM.UNIT_ORDER.indexOf(b.type) || a.id - b.id);
        for (const R of regs) {
          const chip = document.createElement('span');
          chip.className = 'chip';
          const cv = document.createElement('canvas'); cv.width = 16; cv.height = 18;
          this.chipIcon(cv, R.type, t);
          const bar = document.createElement('b');
          chip.appendChild(cv); chip.appendChild(bar);
          chip.addEventListener('click', () => {
            if (!R.alive) return;
            g.flyTo(R.n ? R.cx : R.fcx, R.n ? R.cy : R.fcy, Math.max(g.cam.goalZoom(), 2 / g.cam.dpr));
            g.cam.followReg = R; // then keep it in view
          });
          chip.addEventListener('mouseenter', () => { g.renderer.focusReg = R; });
          chip.addEventListener('mouseleave', () => { if (g.renderer.focusReg === R) g.renderer.focusReg = null; });
          el.appendChild(chip);
          this.chips.push({ R, chip, bar, st: '', w: -1, tip: '' });
        }
      }
      if (g.renderer) g.renderer.focusReg = null;
    },

    // the largest sprite size of the unit that fits the chip
    chipIcon(cv, type, team) {
      const S = TM.Sprites, c = cv.getContext('2d');
      for (const set of S.sets) {
        const fr = set.meta[type].idle[set.nd === 16 ? 3 : 2][0].body;
        if (fr.w <= cv.width + 2 && fr.h <= cv.height + 2) {
          c.imageSmoothingEnabled = false;
          c.drawImage(set.color[team], fr.x, fr.y, fr.w, fr.h, Math.round((cv.width - fr.w) / 2), Math.round((cv.height - fr.h) / 2) + 1, fr.w, fr.h);
          return;
        }
      }
    },

    updateChips(B) {
      if (B !== this.chipB) this.buildChips(B);
      const ON = TM.Tactics.ORDER_NAME;
      for (const c of this.chips) {
        const R = c.R;
        let mor = 0, mn = 0;
        if (R.n && !R.def.fearless) for (const u of R.members) if (u.state === 0 && !u.fleeing) { mor += u.morale; mn++; }
        const morale = mn ? mor / mn : 100;
        const st = R.alive === 0 ? 'dead' : R.routing || R.n === 0 ? 'rout' : R.engaged > 0.15 ? 'eng' : morale < 38 ? 'waver' : '';
        if (st !== c.st) { c.chip.className = 'chip' + (st ? ' ' + st : ''); c.st = st; }
        const w = Math.round(14 * R.alive / R.n0);
        if (w !== c.w) { c.bar.style.width = w + 'px'; c.w = w; }
        const tip = `${R.name[0].toUpperCase() + R.name.slice(1)}: ${R.alive} из ${R.n0}` +
          (R.alive === 0 ? ' — уничтожены' : R.routing || R.n === 0 ? ' — бегут' : ` — ${ON[R.order] || R.order}` + (R.def.fearless ? '' : `, мораль ${Math.round(morale)}%`) + `, силы ${Math.round((R.sta == null ? 1 : R.sta) * 100)}%`);
        if (tip !== c.tip) { c.chip.title = tip; c.tip = tip; }
      }
    },

    // unit portrait as an <img> source (cached)
    icon(type, team) {
      const key = type + team;
      this.icons = this.icons || {};
      if (!this.icons[key]) {
        const c = document.createElement('canvas'); c.width = c.height = 40;
        TM.Render.drawIcon(c, type, team);
        this.icons[key] = c.toDataURL();
      }
      return this.icons[key];
    },

    // a big title over the field for a few seconds
    banner(title, sub, cls) {
      const el = $('banner');
      el.className = cls || '';
      el.querySelector('.bn-title').textContent = title;
      el.querySelector('.bn-sub').textContent = sub || '';
      void el.offsetWidth; // restart the animation
      el.classList.add('show');
    },

    // turning points of the battle get a title as well as a feed line
    bannerFor(ev, B) {
      if (ev.kind === 'win') this.banner('ПОБЕДА', TM.TEAMS[ev.team].full, 't' + ev.team);
      else if (ev.kind === 'break' && !B.endTime) this.banner(`${TM.TEAMS[ev.team].name.toUpperCase()} ДРОГНУЛИ!`, 'армия бежит с поля', 'warn');
    },

    // A feed line; an event with a place on the field shows it when hovered and flies the camera
    // there on click.
    pushFeed(ev) {
      const feed = $('feed'), g = this.game;
      const d = document.createElement('div');
      d.className = 'feed-item t' + ev.team + (ev.kind ? ' k-' + ev.kind : '') + (ev.x != null ? ' go' : '');
      if (ev.type) { const im = document.createElement('img'); im.src = this.icon(ev.type, ev.team); im.alt = ''; d.appendChild(im); }
      const tx = document.createElement('span');
      tx.innerHTML = `<i>${TM.U.fmtTime(ev.time)}</i> `;
      tx.appendChild(document.createTextNode(ev.text));
      d.appendChild(tx);
      if (ev.x != null) {
        d.title = 'Показать на поле';
        const big = ev.kind === 'break' || ev.kind === 'win' || ev.kind === 'rally';
        d.addEventListener('click', () => g.flyTo(ev.x, ev.y, Math.max(g.cam.goalZoom(), (big ? 1 : 2) / g.cam.dpr)));
        d.addEventListener('mouseenter', () => { g.renderer.focusEvent = ev; });
        d.addEventListener('mouseleave', () => { if (g.renderer.focusEvent === ev) g.renderer.focusEvent = null; });
      }
      feed.prepend(d);
      const drop = (el) => { if (g.renderer.focusEvent && el._ev === g.renderer.focusEvent) g.renderer.focusEvent = null; el.remove(); };
      d._ev = ev;
      while (feed.children.length > 7) drop(feed.lastChild);
      setTimeout(() => d.classList.add('fade'), 7000);
      setTimeout(() => { if (d.parentNode) drop(d); }, 7700);
    },

    // ---------------- tooltip ----------------
    showTooltip(u, sx, sy) {
      const tt = $('tooltip');
      if (!u) { tt.style.display = 'none'; return; }
      const team = TM.TEAMS[u.team];
      const m = Math.round(u.morale);
      const mc = m > 60 ? '#7bd14b' : m > 30 ? '#e8c23a' : '#e2452f';
      const sp = Math.round((u.sta == null ? 1 : u.sta) * 100), sc = sp > 50 ? '#8fc7e8' : sp > 25 ? '#e8c23a' : '#e2452f';
      tt.innerHTML =
        `<span class="tt-name t${u.team}">${u.def.name}</span> · ${team.name.toLowerCase()}` +
        (u.fleeing ? ' · <span class="panic">БЕЖИТ</span>' : '') +
        `<br>HP ${Math.ceil(u.hp)}/${u.maxHp} · убийств: ${u.kills}` +
        (u.reg && u.reg.alive ? `<br>Полк: ${u.reg.name} (${u.reg.n}) — ${u.reg.routing ? 'бегут' : TM.Tactics.ORDER_NAME[u.reg.order] || u.reg.order}` : '') +
        (u.def.fearless ? '<br>Мораль: не знает страха' : `<br>Мораль ${m}%<span class="mbar"><i style="width:${m}%;background:${mc}"></i></span>`) +
        `<br>Силы ${sp}%<span class="mbar"><i style="width:${sp}%;background:${sc}"></i></span>${sp < 25 ? ' <span class="panic">выдохся</span>' : ''}`;
      tt.style.display = 'block';
      const w = tt.offsetWidth, h = tt.offsetHeight;
      tt.style.left = Math.min(window.innerWidth - w - 8, sx + 16) + 'px';
      tt.style.top = Math.min(window.innerHeight - h - 8, sy + 16) + 'px';
    },

    // ---------------- results ----------------
    showResult(B) {
      const el = $('result');
      const w = B.winner;
      const title = w === 2 ? 'ВЗАИМНОЕ УНИЧТОЖЕНИЕ' : `ПОБЕДА: ${TM.TEAMS[w].full.toUpperCase()}`;
      const s0 = B.stats[0], s1 = B.stats[1];
      const surv = w < 2 ? B.stats[w].alive : 0;
      const totalDead = s0.dead + s1.dead;
      let rows = '';
      const cell = (st, k) => {
        const bt = st.byType[k];
        const left = bt.deployed - bt.dead - bt.fled;
        return `<td>${bt.deployed} <span class="dim">→</span> ${left}</td><td>${bt.kills}</td>`;
      };
      for (const k of TM.UNIT_ORDER) {
        if (!s0.byType[k].deployed && !s1.byType[k].deployed) continue;
        rows += `<tr><td>${TM.UNIT_TYPES[k].name}</td>${cell(s0, k)}${cell(s1, k)}</tr>`;
      }
      rows += `<tr class="total"><td>Итого</td><td>${s0.deployed} <span class="dim">→</span> ${s0.alive}</td><td>${s0.kills}</td><td>${s1.deployed} <span class="dim">→</span> ${s1.alive}</td><td>${s1.kills}</td></tr>`;
      const mvp = B.mvp();
      const mvpHtml = mvp
        ? `<div class="mvp">🏆 Герой битвы: <b>${mvp.def.name}</b> (${TM.TEAMS[mvp.team].name.toLowerCase()}) — ${mvp.kills} убийств, ${Math.round(mvp.dmg)} урона${mvp.state === TM.Units.ALIVE ? ', выжил' : ', пал в бою'} <button class="mvp-go" id="res-hero">${mvp.state === TM.Units.ALIVE ? 'Показать' : 'Где пал'}</button></div>`
        : '';
      el.innerHTML = `
        <div class="card result-card">
          <div class="result-title t${w}">${title}</div>
          <div class="result-sub">Длительность ${TM.U.fmtTime(B.duration())} · погибло ${totalDead} · бежало ${s0.fled + s1.fled}${s0.teamkills + s1.teamkills ? ` · убито своими ${s0.teamkills + s1.teamkills}` : ''}${w < 2 ? ` · выжило ${surv} из ${B.stats[w].deployed}` : ''}</div>
          <table class="result-table">
            <tr><th>Отряд</th><th class="r">Красные: было → осталось</th><th class="r">Убийств</th><th class="b">Синие: было → осталось</th><th class="b">Убийств</th></tr>
            ${rows}
          </table>
          ${this.chartHtml()}
          ${mvpHtml}
          <div class="result-buttons">
            <button class="btn primary" id="res-restart">↻ Реванш (R)</button>
            <button class="btn" id="res-view">Осмотреть поле боя</button>
            <button class="btn" id="res-new">⚑ Изменить армии (Esc)</button>
          </div>
        </div>`;
      el.classList.remove('hidden');
      this.initChart(B);
      $('res-restart').onclick = () => this.game.restart();
      $('res-view').onclick = () => el.classList.add('hidden');
      $('res-new').onclick = () => this.game.toSetup();
      if (mvp) $('res-hero').onclick = () => {
        // close-up of the hero (followed while he lives), or of the place where he fell
        const g = this.game;
        el.classList.add('hidden');
        g.flyTo(mvp.x, mvp.y, 3 / g.cam.dpr);
        if (mvp.state === TM.Units.ALIVE) g.cam.follow = mvp;
      };
    },

    // ---------------- battle chart (result screen) ----------------
    // How many soldiers each army had in its ranks over the battle, with the moments regiments broke.
    // Series colours are the team hues stepped for the dark card (checked for colour-blind separation).
    chartHtml() {
      const h = this.game.hist;
      if (!h || h.t.length < 3) return '';
      return `<div class="rchart">
        <div class="rchart-head"><span class="rchart-title">Ход битвы: бойцов в строю</span>
          <span class="rchart-legend"><span><i class="lk" style="background:${CHART_COL[0]}"></i>Красные</span><span><i class="lk" style="background:${CHART_COL[1]}"></i>Синие</span><span><i class="tk"></i>полк бежит</span></span></div>
        <div class="rchart-wrap"><canvas id="rchart"></canvas><div class="rchart-tip"></div></div>
      </div>`;
    },

    initChart(B) {
      const cv = $('rchart');
      if (!cv) return;
      const h = this.game.hist, tip = cv.parentNode.querySelector('.rchart-tip');
      const marks = B.events.filter((e) => e.kind === 'rout' || e.kind === 'break');
      const draw = (hi) => this.drawChart(cv, h, marks, hi);
      draw(-1);
      const pick = (e) => {
        const r = cv.getBoundingClientRect(), g = this.chartGeom;
        const t = (e.clientX - r.left - g.L) / g.pw * g.t1;
        let best = 0;
        for (let i = 1; i < h.t.length; i++) if (Math.abs(h.t[i] - t) < Math.abs(h.t[best] - t)) best = i;
        return best;
      };
      cv.addEventListener('mousemove', (e) => {
        const i = pick(e), g = this.chartGeom;
        draw(i);
        tip.textContent = '';
        const head = document.createElement('div'); head.className = 'tt-time'; head.textContent = TM.U.fmtTime(h.t[i]); tip.appendChild(head);
        for (let t = 0; t < 2; t++) {
          const row = document.createElement('div');
          const k = document.createElement('i'); k.className = 'lk'; k.style.background = CHART_COL[t];
          const v = document.createElement('b'); v.textContent = h.a[t][i];
          const n = document.createElement('span'); n.textContent = ' ' + TM.TEAMS[t].name.toLowerCase();
          row.appendChild(k); row.appendChild(v); row.appendChild(n); tip.appendChild(row);
        }
        const x = g.X(h.t[i]);
        tip.style.display = 'block';
        tip.style.left = (x + 12 + tip.offsetWidth > cv.clientWidth ? x - 12 - tip.offsetWidth : x + 12) + 'px';
      });
      cv.addEventListener('mouseleave', () => { draw(-1); tip.style.display = 'none'; });
    },

    drawChart(cv, h, marks, hi) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = cv.clientWidth, Hh = cv.clientHeight;
      if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr); }
      const c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, Hh);
      const L = 34, Rm = 42, T = 6, Bm = 30, pw = W - L - Rm, ph = Hh - T - Bm;
      const n = h.t.length, t1 = Math.max(1, h.t[n - 1]);
      let vmax = 1;
      for (let t = 0; t < 2; t++) for (const v of h.a[t]) if (v > vmax) vmax = v;
      const step = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500].find((s) => vmax / s <= 4) || 5000;
      const ymax = Math.ceil(vmax / step) * step;
      const X = (t) => L + t / t1 * pw, Y = (v) => T + ph - v / ymax * ph;
      this.chartGeom = { L, pw, t1, X };
      c.font = '10px "Segoe UI", system-ui, sans-serif';
      c.textBaseline = 'middle';
      // grid & axes: solid hairlines one step off the card
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(255, 235, 200, 0.08)';
      c.fillStyle = '#9b917f';
      c.textAlign = 'right';
      for (let v = 0; v <= ymax; v += step) {
        const y = Math.round(Y(v)) + 0.5;
        c.beginPath(); c.moveTo(L, y); c.lineTo(L + pw, y); c.stroke();
        c.fillText(String(v), L - 6, y);
      }
      const ts = [5, 10, 15, 30, 60, 120, 300].find((s) => t1 / s <= 7) || 600;
      c.textAlign = 'center'; c.textBaseline = 'top';
      for (let t = 0; t <= t1 + 1e-6; t += ts) c.fillText(TM.U.fmtTime(t), Math.round(X(t)), T + ph + 15);
      // area washes, then the lines (2px, round joins)
      for (let t = 0; t < 2; t++) {
        const a = h.a[t];
        c.beginPath(); c.moveTo(X(h.t[0]), Y(0));
        for (let i = 0; i < n; i++) c.lineTo(X(h.t[i]), Y(a[i]));
        c.lineTo(X(h.t[n - 1]), Y(0)); c.closePath();
        c.globalAlpha = 0.1; c.fillStyle = CHART_COL[t]; c.fill(); c.globalAlpha = 1;
      }
      c.lineWidth = 2; c.lineJoin = 'round'; c.lineCap = 'round';
      for (let t = 0; t < 2; t++) {
        const a = h.a[t];
        c.strokeStyle = CHART_COL[t];
        c.beginPath();
        for (let i = 0; i < n; i++) { const x = X(h.t[i]), y = Y(a[i]); if (i) c.lineTo(x, y); else c.moveTo(x, y); }
        c.stroke();
      }
      // regiments that broke: ticks under the axis, in the colour of their army
      for (const e of marks) {
        if (e.time > t1) continue;
        const x = Math.round(X(e.time)), y = T + ph + 3, big = e.kind === 'break';
        c.fillStyle = CHART_COL[e.team];
        c.beginPath(); c.moveTo(x, y); c.lineTo(x - (big ? 5 : 3.5), y + (big ? 8 : 6)); c.lineTo(x + (big ? 5 : 3.5), y + (big ? 8 : 6)); c.closePath(); c.fill();
      }
      // end values, unless they would collide (the legend and the tooltip carry them then)
      const e0 = Y(h.a[0][n - 1]), e1 = Y(h.a[1][n - 1]);
      c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = '#ebe4d6';
      if (Math.abs(e0 - e1) >= 12) for (let t = 0; t < 2; t++) c.fillText(String(h.a[t][n - 1]), L + pw + 8, t ? e1 : e0);
      // hover: crosshair snapped to the nearest sample, dots with a ring in the card colour
      if (hi >= 0) {
        const x = Math.round(X(h.t[hi])) + 0.5;
        c.strokeStyle = 'rgba(255, 235, 200, 0.35)'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + ph); c.stroke();
        for (let t = 0; t < 2; t++) {
          const y = Y(h.a[t][hi]);
          c.fillStyle = '#1a1612'; c.beginPath(); c.arc(x, y, 6, 0, Math.PI * 2); c.fill();
          c.fillStyle = CHART_COL[t]; c.beginPath(); c.arc(x, y, 4, 0, Math.PI * 2); c.fill();
        }
      }
    },

    // ---------------- minimap ----------------
    // The whole field: the ground layer (with its blood, bodies and fallen standards) refreshed every
    // couple of seconds, the soldiers 10 times a second, the camera frame and event pings every frame.
    initMinimap() {
      const cv = $('minimap');
      this.mm = { cv, ctx: cv.getContext('2d'), base: document.createElement('canvas'), dots: document.createElement('canvas'), gT: -1e9, dT: -1e9, w: 0, h: 0 };
      const C = TM.CONFIG, g = this.game;
      let drag = false;
      const at = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * C.WORLD_W, y: (e.clientY - r.top) / r.height * C.WORLD_H }; };
      cv.addEventListener('mousedown', (e) => { e.stopPropagation(); drag = true; const w = at(e); g.flyTo(w.x, w.y); g.cam.anim.dur = 0.3; });
      window.addEventListener('mousemove', (e) => { if (!drag) return; const w = at(e); g.cam.stop(); g.cam.x = w.x; g.cam.y = w.y; g.cam.clamp(); });
      window.addEventListener('mouseup', () => { drag = false; });
      cv.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    },

    toggleMinimap() { $('minimap').classList.toggle('off'); },

    drawMinimap(B, cam, R) {
      const m = this.mm;
      if (!m || this.game.mode !== 'battle' || m.cv.classList.contains('off')) return;
      const C = TM.CONFIG, now = performance.now();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(m.cv.clientWidth * dpr), h = Math.round(m.cv.clientHeight * dpr);
      if (!w || !h) return;
      if (w !== m.w || h !== m.h) {
        m.w = m.cv.width = m.base.width = m.dots.width = w; m.h = m.cv.height = m.base.height = m.dots.height = h;
        m.gT = m.dT = -1e9;
      }
      const sx = w / C.WORLD_W, sy = h / C.WORLD_H;
      if (now - m.gT > 2000) {
        m.gT = now;
        const b = m.base.getContext('2d');
        b.imageSmoothingEnabled = true; b.imageSmoothingQuality = 'medium';
        b.drawImage(this.game.fx.ground, 0, 0, w, h);
        b.fillStyle = 'rgba(12, 10, 8, 0.28)'; b.fillRect(0, 0, w, h);
      }
      if (now - m.dT > 100) {
        m.dT = now;
        const d = m.dots.getContext('2d');
        d.clearRect(0, 0, w, h);
        d.drawImage(m.base, 0, 0);
        const s = dpr >= 1.5 ? 2 : 1.5;
        const cols = [['#ff6a58', '#ffb79a'], ['#5aa8ff', '#b7d6ff']];
        for (let t = 0; t < 2; t++) {
          for (let f = 0; f < 2; f++) {
            d.fillStyle = cols[t][f];
            d.globalAlpha = f ? 0.55 : 1;
            for (const u of B.alive[t]) if (u.fleeing === !!f) d.fillRect(u.x * sx - s / 2, u.y * sy - s / 2, u.type === 'giant' ? s * 2 : s, u.type === 'giant' ? s * 2 : s);
          }
        }
        d.globalAlpha = 1;
      }
      const c = m.ctx;
      c.clearRect(0, 0, w, h);
      c.drawImage(m.dots, 0, 0);
      // pings of the latest events
      const ev = B.events;
      c.lineWidth = dpr;
      for (let i = ev.length - 1; i >= 0; i--) {
        const e = ev[i], age = B.time - e.time;
        if (age > 2.5) break;
        if (e.x == null) continue;
        c.strokeStyle = e.kind === 'rout' || e.kind === 'break' ? '#ffb347' : e.kind === 'win' ? '#ffd34d' : TM.TEAMS[e.team].light;
        c.globalAlpha = 1 - age / 2.5;
        c.beginPath(); c.arc(e.x * sx, e.y * sy, (3 + age * 7) * dpr, 0, Math.PI * 2); c.stroke();
      }
      c.globalAlpha = 1;
      // camera frame
      const z = cam.view(), vw = R.vw / z, vh = R.vh / z;
      c.strokeStyle = 'rgba(255, 228, 140, 0.95)'; c.lineWidth = Math.max(1, dpr);
      c.strokeRect(Math.round((cam.x - vw / 2) * sx) + 0.5, Math.round((cam.y - vh / 2) * sy) + 0.5, Math.round(vw * sx), Math.round(vh * sy));
    },

    hideResult() { $('result').classList.add('hidden'); },
    toggleHelp() { $('help').classList.toggle('hidden'); },
    helpVisible() { return !$('help').classList.contains('hidden'); },
  };

  UI.SPEEDS = SPEEDS;
  TM.UI = UI;
})(window.TM = window.TM || {});
