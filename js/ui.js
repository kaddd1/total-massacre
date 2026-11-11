// DOM user interface: army setup panels, presets, HUD, kill feed, tooltip, results.
(function (TM) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
  const SHORT = { sword: 'Меч', spear: 'Коп', archer: 'Лук', knight: 'Рыц', giant: 'Вел' };

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
      $('btn-fit').addEventListener('click', () => game.fit());
      $('btn-restart').addEventListener('click', () => game.restart());
      $('btn-new').addEventListener('click', () => game.toSetup());
      $('btn-help').addEventListener('click', () => this.toggleHelp());
      document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('.modal').classList.add('hidden')));
      TM.Editor.init(game);
      TM.Audio.bindUI();
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
      this.feedSeen = 0;
    },

    syncControls() {
      const g = this.game;
      $('btn-pause').textContent = g.paused ? '▶' : '❚❚';
      $('btn-pause').classList.toggle('on', g.paused);
      $('btn-auto').classList.toggle('on', g.cam.auto);
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
      while (this.feedSeen < B.events.length) this.pushFeed(B.events[this.feedSeen++]);
    },

    pushFeed(ev) {
      const feed = $('feed');
      const d = document.createElement('div');
      d.className = 'feed-item t' + ev.team;
      d.textContent = `${TM.U.fmtTime(ev.time)}  ${ev.text}`;
      feed.prepend(d);
      while (feed.children.length > 7) feed.lastChild.remove();
      setTimeout(() => d.classList.add('fade'), 6000);
      setTimeout(() => d.remove(), 6700);
    },

    // ---------------- tooltip ----------------
    showTooltip(u, sx, sy) {
      const tt = $('tooltip');
      if (!u) { tt.style.display = 'none'; return; }
      const team = TM.TEAMS[u.team];
      const m = Math.round(u.morale);
      const mc = m > 60 ? '#7bd14b' : m > 30 ? '#e8c23a' : '#e2452f';
      tt.innerHTML =
        `<span class="tt-name t${u.team}">${u.def.name}</span> · ${team.name.toLowerCase()}` +
        (u.fleeing ? ' · <span class="panic">БЕЖИТ</span>' : '') +
        `<br>HP ${Math.ceil(u.hp)}/${u.maxHp} · убийств: ${u.kills}` +
        (u.reg && u.reg.alive ? `<br>Полк: ${u.reg.name} (${u.reg.n}) — ${u.reg.routing ? 'бегут' : TM.Tactics.ORDER_NAME[u.reg.order] || u.reg.order}` : '') +
        (u.def.fearless ? '<br>Мораль: не знает страха' : `<br>Мораль ${m}%<span class="mbar"><i style="width:${m}%;background:${mc}"></i></span>`);
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
        ? `<div class="mvp">🏆 Герой битвы: <b>${mvp.def.name}</b> (${TM.TEAMS[mvp.team].name.toLowerCase()}) — ${mvp.kills} убийств, ${Math.round(mvp.dmg)} урона${mvp.state === TM.Units.ALIVE ? ', выжил' : ', пал в бою'}</div>`
        : '';
      el.innerHTML = `
        <div class="card result-card">
          <div class="result-title t${w}">${title}</div>
          <div class="result-sub">Длительность ${TM.U.fmtTime(B.duration())} · погибло ${totalDead} · бежало ${s0.fled + s1.fled}${s0.teamkills + s1.teamkills ? ` · убито своими ${s0.teamkills + s1.teamkills}` : ''}${w < 2 ? ` · выжило ${surv} из ${B.stats[w].deployed}` : ''}</div>
          <table class="result-table">
            <tr><th>Отряд</th><th class="r">Красные: было → осталось</th><th class="r">Убийств</th><th class="b">Синие: было → осталось</th><th class="b">Убийств</th></tr>
            ${rows}
          </table>
          ${mvpHtml}
          <div class="result-buttons">
            <button class="btn primary" id="res-restart">↻ Реванш (R)</button>
            <button class="btn" id="res-view">Осмотреть поле боя</button>
            <button class="btn" id="res-new">⚑ Изменить армии (Esc)</button>
          </div>
        </div>`;
      el.classList.remove('hidden');
      $('res-restart').onclick = () => this.game.restart();
      $('res-view').onclick = () => el.classList.add('hidden');
      $('res-new').onclick = () => this.game.toSetup();
    },

    hideResult() { $('result').classList.add('hidden'); },
    resultVisible() { return !$('result').classList.contains('hidden'); },
    toggleHelp() { $('help').classList.toggle('hidden'); },
    helpVisible() { return !$('help').classList.contains('hidden'); },
  };

  UI.SPEEDS = SPEEDS;
  TM.UI = UI;
})(window.TM = window.TM || {});
