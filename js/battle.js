// Battle world: spawning, fixed-step simulation, combat resolution, stats.
(function (TM) {
  'use strict';
  const U = TM.U;
  const { ALIVE, DYING, DEAD, ESCAPED, breathe } = TM.Units;
  const buf = [];

  function emptyStats() {
    const byType = {};
    for (const k of TM.UNIT_ORDER) byType[k] = { deployed: 0, dead: 0, fled: 0, kills: 0, dmg: 0 };
    return { deployed: 0, alive: 0, dead: 0, fled: 0, fleeing: 0, kills: 0, teamkills: 0, byType };
  }

  class Battle {
    // setup: { armies: [{counts, formation}, {counts, formation}], morale, friendlyFire, seed }
    constructor(setup, fx) {
      const C = TM.CONFIG;
      this.setup = setup;
      this.fx = fx;
      this.W = C.WORLD_W; this.H = C.WORLD_H;
      this.opts = { morale: setup.morale !== false, friendlyFire: setup.friendlyFire !== false };
      this.seed = setup.seed || ((Math.random() * 1e9) | 0);
      U.seed(this.seed);

      this.grid = new TM.SpatialGrid(this.W, this.H, C.GRID_CELL);
      this.units = [];
      this.alive = [[], []];
      this.arrows = [];
      this.stats = [emptyStats(), emptyStats()];
      this.contact = [false, false];
      // where routed units run to: own side of the map (left/right for automatic formations)
      this.home = [{ x: -TM.TEAMS[0].dir, y: 0 }, { x: -TM.TEAMS[1].dir, y: 0 }];
      this.events = [];
      this.time = 0;
      this.state = 'deploy'; // deploy | running | over
      this.winner = -1;
      this.endTime = 0;
      this.firstBlood = false;
      this.broken = [false, false];
      this.routT = [0, 0];
      this.trampleAcc = 0;
      this.lastCritText = -1;
      this.hitTick = 0;
      this.tickN = 0;
      // hand-placed armies can stand anywhere (e.g. one above the other): see rebuild()
      this.freeMarch = setup.armies.some((a) => a.formation === 'manual');

      let id = 0;
      const specs = [], specOf = new Map();
      for (let t = 0; t < 2; t++) {
        const army = setup.armies[t];
        const spots = TM.Formations.spawn(t, army);
        for (const s of spots) {
          const u = TM.Units.create(id++, t, s.type, s.x, s.y);
          if (s.angle != null) u.facing = u.faceTo = s.angle; // regiments face where they were deployed
          this.units.push(u);
          this.stats[t].deployed++;
          this.stats[t].byType[s.type].deployed++;
          // every spot belongs to a regiment (an editor group or a part of an automatic formation)
          const key = t + ':' + s.reg + ':' + s.type;
          let spec = specOf.get(key);
          if (!spec) { spec = { team: t, type: s.type, angle: s.angle || 0, doctrine: s.doctrine || 'line', members: [] }; specOf.set(key, spec); specs.push(spec); }
          spec.members.push(u);
        }
      }
      // shuffle so neither army systematically acts first within a tick
      for (let i = this.units.length - 1; i > 0; i--) {
        const j = (U.rand() * (i + 1)) | 0;
        const tmp = this.units[i]; this.units[i] = this.units[j]; this.units[j] = tmp;
      }
      this.rebuild();
      TM.Tactics.build(this, specs);
    }

    start() {
      if (this.state === 'deploy') this.state = 'running';
    }

    // ---- sound hooks (one-way: the simulation only reports "what happened where") ----
    // TM.Audio.live is false unless the real game is playing, so tests / previews pay nothing.
    // Audio never touches the seeded RNG; hitTick is a plain counter used to alternate sounds.
    snd(k, x, y) { const A = TM.Audio; if (A && A.live) A.emit(k, x, y); }
    hitSound(kind, v, dmg, crit) {
      const A = TM.Audio, x = v.x, y = v.y;
      if (kind === 'melee') {
        const t = ++this.hitTick, armored = v.def.block > 0 || v.def.armor;
        if (v.def.block > 0.3 && t % 3 === 0) A.emit('shield', x, y); // blows caught on a wooden shield
        else if (armored) A.emit('clash', x, y);                     // steel on steel / armour
        if (!armored || (t & 1)) A.emit('flesh', x, y);
      } else if (kind === 'arrow') A.emit('arrowhit', x, y);
      else if (kind === 'charge') A.emit('charge', x, y);
      else if (kind === 'brace') A.emit('brace', x, y);
      else if (kind === 'fall') A.emit('fall', x, y);
      if (v.hp > 0 && v.type !== 'giant' && kind !== 'fall' && (crit || dmg >= 16)) A.emit('pain', x, y);
    }

    lossRatio(team) {
      const s = this.stats[team];
      return s.deployed ? (s.dead + s.fled) / s.deployed : 0;
    }

    duration() {
      return this.endTime || this.time;
    }

    // a line for the event feed; x, y (where it happened), kind and unit type are for the
    // map pings and the feed icons only — nothing in the simulation reads them
    event(text, team, x, y, kind, type) {
      this.events.push({ time: this.time, text, team, x, y, kind, type });
    }

    // Rebuild alive lists, spatial grid, centroids, attacker counts.
    rebuild() {
      const a0 = this.alive[0], a1 = this.alive[1];
      a0.length = 0; a1.length = 0;
      this.grid.clear();
      let cx0 = 0, cy0 = 0, cx1 = 0, cy1 = 0, f0 = 0, f1 = 0;
      const units = this.units;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.state !== ALIVE) continue;
        u.attackers = 0;
        if (u.team === 0) { a0.push(u); cx0 += u.x; cy0 += u.y; if (u.fleeing) f0++; }
        else { a1.push(u); cx1 += u.x; cy1 += u.y; if (u.fleeing) f1++; }
        this.grid.insert(u);
      }
      let idx = 0;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.state !== ALIVE) continue;
        u.idx = idx++;
        if (u.target && !u.def.ranged && u.target.state === ALIVE) u.target.attackers++;
      }
      this.stats[0].alive = a0.length; this.stats[1].alive = a1.length;
      this.stats[0].fleeing = f0; this.stats[1].fleeing = f1;
      if (a0.length && a1.length) {
        cx0 /= a0.length; cy0 /= a0.length; cx1 /= a1.length; cy1 /= a1.length;
        this.center = [{ x: cx0, y: cy0 }, { x: cx1, y: cy1 }];
        // hand-placed armies can stand anywhere: home is straight away from the enemy
        if (this.freeMarch) {
          for (let t = 0; t < 2; t++) {
            const me = this.center[t], en = this.center[1 - t];
            let mx = en.x - me.x, my = en.y - me.y;
            if (!mx && !my) mx = TM.TEAMS[t].dir;
            const l = Math.hypot(mx, my);
            this.home[t].x = -mx / l; this.home[t].y = -my / l;
          }
        }
      }
    }

    step(dt) {
      if (this.state === 'deploy') return;
      this.time += dt;
      this.tickN++;
      this.rebuild();
      TM.Tactics.update(this, dt);

      const units = this.units;
      // behaviour
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.state === ALIVE) TM.Units.update(u, this, dt);
      }
      // integrate motion
      const G = TM.CONFIG.GRAVITY;
      const groundFric = Math.exp(-7 * dt), airFric = Math.exp(-0.6 * dt);
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.state === ALIVE) this.integrate(u, dt, G, groundFric, airFric);
        else if (u.state === DYING) this.updateDying(u, dt, G, groundFric, airFric);
      }
      this.collide();
      this.updateArrows(dt);
      this.fx.update(dt);
      this.fx.tick(this, dt);
      this.trample(dt);
      this.checkMoraleBreak();
      this.checkEnd();
    }

    integrate(u, dt, G, groundFric, airFric) {
      const d = u.def;
      if (u.z <= 0.5) {
        let ax = u.desX - u.vx, ay = u.desY - u.vy;
        const l = Math.hypot(ax, ay), maxDv = d.accel * dt;
        if (l > maxDv) { ax *= maxDv / l; ay *= maxDv / l; }
        u.vx += ax; u.vy += ay;
      }
      u.x += (u.vx + u.kx) * dt;
      u.y += (u.vy + u.ky) * dt;
      const fr = u.z > 0 ? airFric : groundFric;
      u.kx *= fr; u.ky *= fr;

      if (u.z > 0 || u.vz !== 0) {
        u.vz -= G * dt;
        u.z += u.vz * dt;
        if (u.z <= 0) {
          const impact = -u.vz;
          u.z = 0; u.vz = 0;
          if (impact > 170) {
            this.fx.dust(u.x, u.y, 4, 3);
            u.stunT = 0.35;
            this.hit(null, u, (impact - 170) * 0.09, 'fall', 0, 0, 0);
          }
        }
      }

      const sp = Math.sqrt(u.vx * u.vx + u.vy * u.vy);
      u.moveAmt = sp / d.speed;
      if (((this.tickN + u.id) & 3) === 0) breathe(u, this, sp, dt * 4);   // stamina: every 4th tick, staggered
      const w0 = u.walk;
      u.walk += sp * dt * 0.22;
      if (sp > 12 && (d.charge || u.type === 'giant')) {
        // footfalls: hooves of galloping knights, stomps of giants
        const per = u.type === 'giant' ? 3.77 : Math.PI;
        if (((u.walk / per) | 0) !== ((w0 / per) | 0)) {
          this.snd(u.type === 'giant' ? 'stomp' : 'hoof', u.x, u.y);
          if (u.type === 'giant') this.fx.stomp(u.x, u.y);
        }
      }
      const turn = u.type === 'giant' ? 3 : u.type === 'knight' ? 5 : 9;
      u.facing = U.turnTo(u.facing, u.faceTo, turn * dt);

      // bounds (fleeing units may leave through the map edge)
      const r = u.r;
      if (u.fleeing) {
        if (u.x < -12 || u.x > this.W + 12 || u.y < -12 || u.y > this.H + 12) return this.escape(u);
      } else {
        if (u.x < r) { u.x = r; u.kx = Math.abs(u.kx) * 0.3; }
        else if (u.x > this.W - r) { u.x = this.W - r; u.kx = -Math.abs(u.kx) * 0.3; }
        if (u.y < r) { u.y = r; u.ky = Math.abs(u.ky) * 0.3; }
        else if (u.y > this.H - r) { u.y = this.H - r; u.ky = -Math.abs(u.ky) * 0.3; }
      }
    }

    updateDying(u, dt, G, groundFric, airFric) {
      u.deathT += dt;
      u.x += u.kx * dt; u.y += u.ky * dt;
      const fr = u.z > 0 ? airFric : groundFric;
      u.kx *= fr; u.ky *= fr;
      if (u.z > 0 || u.vz !== 0) {
        u.vz -= G * dt; u.z += u.vz * dt;
        if (u.z <= 0) { u.z = 0; u.vz = 0; this.fx.dust(u.x, u.y, 3, 3); this.fx.stampBlood(u.x, u.y, u.r); }
      }
      if (u.deathT > 0.55 && u.z <= 0) {
        u.state = DEAD;
        u.x = U.clamp(u.x, 2, this.W - 2); u.y = U.clamp(u.y, 2, this.H - 2);
        this.fx.stampCorpse(u);
      }
    }

    // Soft circle-circle separation with mass weighting + cavalry charge impacts.
    collide() {
      const units = this.units;
      for (let i = 0; i < units.length; i++) {
        const a = units[i];
        if (a.state !== ALIVE || a.z > 6) continue;
        const n = this.grid.query(a.x, a.y, a.r + 18, buf);
        for (let k = 0; k < n; k++) {
          const b = buf[k];
          if (b.idx <= a.idx || b.state !== ALIVE || b.z > 6) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          const minD = a.r + b.r;
          let d2 = dx * dx + dy * dy;
          if (d2 >= minD * minD) continue;
          if (d2 < 0.0001) { dx = U.range(-0.1, 0.1); dy = U.range(-0.1, 0.1); d2 = dx * dx + dy * dy; }
          const d = Math.sqrt(d2);
          const nx = dx / d, ny = dy / d;
          const ov = (minD - d) * 0.75;
          const im = 1 / (a.mass + b.mass);
          const wa = b.mass * im, wb = a.mass * im;
          a.x -= nx * ov * wa; a.y -= ny * ov * wa;
          b.x += nx * ov * wb; b.y += ny * ov * wb;
          if (a.team !== b.team) {
            if (a.type === 'knight') this.chargeImpact(a, b, nx, ny);
            if (b.type === 'knight') this.chargeImpact(b, a, -nx, -ny);
          }
        }
      }
    }

    chargeImpact(k, v, nx, ny) {
      const ch = k.def.charge;
      const sp = Math.hypot(k.vx, k.vy);
      if (sp < ch.minSpeed || v.chargeImmune > 0 || k.state !== ALIVE || v.state !== ALIVE) return;
      // must be riding into the victim
      if ((k.vx * nx + k.vy * ny) / sp < 0.4) return;
      v.chargeImmune = 0.8;
      if (v.type === 'giant') {
        k.vx *= -0.3; k.vy *= -0.3;
        this.hit(k, v, ch.dmg * 0.5, 'charge', nx, ny, 0);
        this.hit(v, k, 25, 'brace', -nx, -ny, 120);
        return;
      }
      if (v.type === 'spear' && !v.fleeing && v.atkT < 0.6) {
        const faceX = Math.cos(v.facing), faceY = Math.sin(v.facing);
        if (faceX * -nx + faceY * -ny > 0.3) {
          // braced spear: the horse impales itself
          this.hit(v, k, v.def.brace * (sp / k.def.speed), 'brace', -nx, -ny, 80);
          k.vx *= 0.2; k.vy *= 0.2;
          this.hit(k, v, ch.dmg * 0.4, 'charge', nx, ny, 60);
          this.fx.sparks(v.x, v.y, 4, 5);
          this.fx.splinters((v.x + k.x) / 2, (v.y + k.y) / 2, 4, 7);
          return;
        }
      }
      const power = sp / k.def.speed;
      const kx = k.vx / sp, ky = k.vy / sp;
      this.hit(k, v, ch.dmg * power, 'charge', kx * 0.7 + nx * 0.3, ky * 0.7 + ny * 0.3, ch.knock * power);
      k.vx *= 0.82; k.vy *= 0.82;
      this.fx.dust(v.x, v.y, 3, 3);
      if (power > 0.8) this.fx.shock(v.x, v.y, 16, false);
      this.fx.shake(0.5);
    }

    // Melee strike lands (called at the end of windup).
    resolveMelee(u) {
      const d = u.def;
      if (d.cleave) {
        const n = this.grid.query(u.x, u.y, u.r + d.reach + 18, buf);
        let hits = 0;
        const dmg = U.range(d.dmgMin, d.dmgMax);
        for (let i = 0; i < n; i++) {
          const o = buf[i];
          if (o === u || o.state !== ALIVE || o.z > 12) continue;
          const dx = o.x - u.x, dy = o.y - u.y, dist = Math.hypot(dx, dy) || 1;
          if (dist - u.r - o.r > d.reach + 4) continue;
          if (Math.abs(U.angDiff(u.facing, Math.atan2(dy, dx))) > d.cleave) continue;
          const nx = dx / dist, ny = dy / dist;
          if (o.team === u.team) {
            if (this.opts.friendlyFire && o.type !== 'giant') { o.kx += nx * 120; o.ky += ny * 120; o.vz = 90; o.z = 0.6; }
            continue;
          }
          this.hit(u, o, dmg * U.range(0.85, 1.1), 'melee', nx, ny, d.knock);
          hits++;
        }
        const ix = u.x + Math.cos(u.facing) * (u.r + 14), iy = u.y + Math.sin(u.facing) * (u.r + 14);
        this.fx.dust(ix, iy, 6, 5);
        this.fx.shock(ix, iy, 30, true);
        this.fx.crack(ix, iy);
        this.fx.shake(hits ? 1.2 + hits * 0.4 : 0.5);
        this.snd('giant', ix, iy);
        return;
      }
      const t = u.atkTarget;
      if (!t || t.state !== ALIVE) return;
      const dx = t.x - u.x, dy = t.y - u.y, dist = Math.hypot(dx, dy) || 1;
      if (dist - u.r - t.r > d.reach + 5) return; // whiff
      this.hit(u, t, U.range(d.dmgMin, d.dmgMax), 'melee', dx / dist, dy / dist, d.knock);
    }

    // Universal damage application.
    hit(a, v, dmg, kind, nx, ny, knock) {
      if (v.state !== ALIVE) return;
      const fx = this.fx;
      if (a) {
        const bonus = a.def.bonusVs && a.def.bonusVs[v.type];
        if (bonus && kind !== 'brace') dmg *= bonus;
      }
      if (kind === 'arrow') {
        if (v.def.block && !v.fleeing && U.rand() < v.def.block) {
          v.blockT = this.time;
          fx.sparks(v.x, v.y, v.z, 3);
          fx.impact(v.x, v.y, v.z, nx, ny, 'block');
          this.snd('block', v.x, v.y);
          return;
        }
        dmg *= v.def.arrowMul;
      }
      else if (kind === 'melee' && v.def.armor) dmg *= v.def.armor;
      if (a && (kind === 'melee' || kind === 'charge')) {
        // a formed regiment struck in the flank or the rear suffers more (and loses heart, see units.js)
        dmg *= TM.Tactics.blowFrom(v, nx, ny);
        a.contactT = v.contactT = this.time;
      }
      if (v.fleeing) dmg *= 1.5;
      let crit = false;
      if (a && kind !== 'fall' && kind !== 'brace') {
        const cc = kind === 'arrow' ? a.def.ranged.crit : a.def.crit;
        if (U.rand() < cc) { crit = true; dmg *= 2; }
      }
      v.hp -= dmg;
      v.hitFlash = 0.12;
      // every blow that makes the monster bleed tells the men around it that it can be killed
      if (a && v.def.terror && a.team !== v.team && kind !== 'fall') a.morale = Math.min(100, a.morale + 1.5);
      if (TM.Audio && TM.Audio.live) this.hitSound(kind, v, dmg, crit);
      // visual-only: pixel flash at the point of impact
      if (kind !== 'fall') {
        const fxKind = crit || kind === 'charge' || kind === 'brace' ? 'crit'
          : kind === 'melee' && a && (a.type === 'sword' || a.type === 'giant') ? 'slash' : 'hit';
        fx.impact(v.x, v.y, v.z, nx, ny, fxKind, v.type === 'giant' ? 20 : v.type === 'knight' ? 12 : 8);
      }
      v.lastHit = a;
      if (a) {
        a.dmg += dmg;
        this.stats[a.team].byType[a.type].dmg += dmg;
      }
      if (knock) {
        const kv = knock * (crit ? 1.5 : 1) / v.mass;
        v.kx += nx * kv; v.ky += ny * kv;
        if (kv > 140) { v.vz = Math.max(v.vz, kv * 0.55); v.z = Math.max(v.z, 0.6); }
      }
      if (v.type !== 'giant' || dmg > 20) {
        fx.blood(v.x, v.y, v.z, nx, ny, 1.5 + dmg * 0.13, crit ? 1.4 : 1);
      }
      if (crit && dmg >= 26 && this.time - this.lastCritText > 0.6) {
        this.lastCritText = this.time;
        fx.text(v.x, v.y - v.r, 'КРИТ!', '#ffd34d', 8);
      }
      v.morale -= dmg / v.maxHp * 15;
      if (v.hp <= 0) this.kill(v, a, nx, ny);
    }

    kill(v, a, nx, ny) {
      v.state = DYING;
      v.hp = 0;
      v.deathT = 0;
      v.deathRot = U.gauss() * 0.9;
      v.atkT = -1;
      v.kx += nx * 30; v.ky += ny * 30;
      const st = this.stats[v.team];
      st.dead++;
      st.byType[v.type].dead++;
      this.fx.blood(v.x, v.y, v.z, nx, ny, v.type === 'giant' ? 26 : 8, 1.3);
      this.snd(v.type === 'giant' ? 'giantdeath' : 'death', v.x, v.y);
      if (v.type === 'knight') this.snd('fall', v.x, v.y); // the horse goes down too
      if (v.type === 'giant') {
        this.fx.shake(5);
        this.fx.dust(v.x, v.y, 14, 8);
        this.event(`${TM.TEAMS[v.team].name}: великан повержен!`, v.team, v.x, v.y, 'giant', 'giant');
      }
      if (!this.firstBlood) {
        this.firstBlood = true;
        this.event(`Первая кровь — ${a ? TM.TEAMS[a.team].name.toLowerCase() : 'земля'}`, a ? a.team : v.team, v.x, v.y, 'blood', a ? a.type : v.type);
      }
      if (a && a.team === v.team) {
        this.stats[a.team].teamkills++;
      } else if (a) {
        a.kills++;
        this.stats[a.team].kills++;
        this.stats[a.team].byType[a.type].kills++;
        const k = a.kills;
        if (k === 10 || k === 20 || k === 35 || k === 50 || k === 75 || k === 100 || (k === 5 && a.type !== 'giant')) {
          this.event(`${a.def.name} (${TM.TEAMS[a.team].name.toLowerCase()}) — ${k} убийств!`, a.team, a.x, a.y, 'hero', a.type);
          this.fx.text(a.x, a.y - a.r - 4, k + ' убийств!', '#fff', 9);
        }
      }
      // morale shock around the body. It sinks in over the next seconds (units.js) and a man who has
      // already seen many comrades fall is shaken less by the next one: the fight hardens him.
      const R = v.def.terror ? 240 : 110;
      const n = this.grid.query(v.x, v.y, R, buf);
      for (let i = 0; i < n; i++) {
        const o = buf[i];
        if (o.state !== ALIVE || o === v) continue;
        const dd = Math.hypot(o.x - v.x, o.y - v.y);
        if (dd > R) continue;
        if (o.team === v.team) {
          if (dd > 110) continue;
          o.shock += v.def.moraleLoss * (1 - dd / 110 * 0.7) / (1 + o.seen * 0.1);
          if (this.time - o.contactT < 2) o.seen++;   // hardened only by a fight one takes part in, not by being shot at
        } else if (v.def.terror) {
          // the monster is down: a roar goes along the line
          o.morale = Math.min(100, o.morale + 30 * (1 - dd / R * 0.5)); o.shock *= 0.3;
        } else o.morale = Math.min(100, o.morale + 1.5);
      }
    }

    escape(u) {
      u.state = ESCAPED;
      const st = this.stats[u.team];
      st.fled++;
      st.byType[u.type].fled++;
    }

    onFlee(u) {
      this.snd('panic', u.x, u.y);
      this.fx.text(u.x, u.y - 10, '!', '#ffffff', 10);
    }
    onRally() {}

    checkMoraleBreak() {
      for (let t = 0; t < 2; t++) {
        const s = this.stats[t];
        if (!this.broken[t] && s.alive > 8 && s.fleeing / s.alive > 0.4) {
          this.broken[t] = true;
          const c = this.center && this.center[t];
          this.event(`${TM.TEAMS[t].name} дрогнули и бегут!`, t, c && c.x, c && c.y, 'break');
          if (this.center) this.snd('rout', this.center[t].x, this.center[t].y);
        } else if (this.broken[t] && s.fleeing / Math.max(1, s.alive) < 0.12) {
          this.broken[t] = false;
          const c = this.center && this.center[t];
          if (s.alive > 8) this.event(`${TM.TEAMS[t].name} снова в строю`, t, c && c.x, c && c.y, 'rally');
        }
      }
    }

    // ---------------- arrows ----------------
    fireArrow(u, t, dist) {
      const r = u.def.ranged;
      const T = dist / r.speed + 0.2;
      const lead = U.range(0.5, 1.0);
      let tx = t.x + t.vx * T * lead, ty = t.y + t.vy * T * lead;
      const err = 4 + dist * r.spread;
      tx += U.gauss() * err; ty += U.gauss() * err;
      this.snd('bow', u.x, u.y);
      this.arrows.push({
        x0: u.x, y0: u.y, tx, ty, t: 0, T, h: 18 + dist * 0.2,
        x: u.x, y: u.y, z: 6, team: u.team, shooter: u,
        dmg: U.range(r.dmgMin, r.dmgMax),
      });
    }

    updateArrows(dt) {
      const arr = this.arrows;
      for (let i = arr.length - 1; i >= 0; i--) {
        const p = arr[i];
        p.t += dt;
        const s = Math.min(1, p.t / p.T);
        p.x = p.x0 + (p.tx - p.x0) * s;
        p.y = p.y0 + (p.ty - p.y0) * s;
        p.z = 6 * (1 - s) + 4 * p.h * s * (1 - s);
        p.s = s;
        if (s < 1) continue;
        arr[i] = arr[arr.length - 1];
        arr.pop();
        this.landArrow(p);
      }
    }

    landArrow(p) {
      // once the battle is decided, arrows still in the air just stick into the ground:
      // they must not kill the survivors after the victory (stats would say "won with 0 left")
      if (this.endTime) {
        const dx = p.tx - p.x0, dy = p.ty - p.y0;
        if (p.tx > 0 && p.ty > 0 && p.tx < this.W && p.ty < this.H) this.fx.stampArrow(p.tx, p.ty, Math.atan2(dy, dx));
        return;
      }
      const n = this.grid.query(p.tx, p.ty, 20, buf);
      let best = null, bd = 1e9;
      for (let i = 0; i < n; i++) {
        const o = buf[i];
        if (o.state !== ALIVE || o.z > 14) continue;
        const d = Math.hypot(o.x - p.tx, o.y - p.ty) - o.r - 1.5;
        if (d <= 0 && d < bd) { bd = d; best = o; }
      }
      const dx = p.tx - p.x0, dy = p.ty - p.y0, l = Math.hypot(dx, dy) || 1;
      if (best && (best.team !== p.team || (this.opts.friendlyFire && U.rand() < 0.5))) {
        this.hit(p.shooter, best, p.dmg, 'arrow', dx / l, dy / l, 25);
      } else if (p.tx > 0 && p.ty > 0 && p.tx < this.W && p.ty < this.H) {
        this.snd('arrowground', p.tx, p.ty);
        this.fx.stampArrow(p.tx, p.ty, Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.6);
      }
    }

    trample(dt) {
      // armies slowly churn the field into mud
      this.trampleAcc += dt;
      if (this.trampleAcc < 0.1) return;
      this.trampleAcc = 0;
      for (let t = 0; t < 2; t++) {
        const list = this.alive[t];
        const k = Math.min(list.length, 6);
        for (let i = 0; i < k; i++) {
          const u = list[(Math.random() * list.length) | 0]; // visual only: keep sim RNG untouched
          if (u.moveAmt > 0.3) this.fx.trample(u.x, u.y, Math.min(u.r * 1.3, 9));
        }
      }
    }

    checkEnd() {
      if (this.state !== 'running') return;
      const a0 = this.stats[0].alive, a1 = this.stats[1].alive;
      // an army with nobody left standing in the ranks for 5 s is routed: the field is lost
      for (let t = 0; t < 2; t++) {
        const s = this.stats[t], o = this.stats[1 - t];
        this.routT[t] = s.alive > 0 && s.alive === s.fleeing && o.alive > o.fleeing ? this.routT[t] + 1 / 60 : 0;
      }
      const routed = this.routT[0] > 5 ? 0 : this.routT[1] > 5 ? 1 : -1;
      if (!this.endTime && (a0 === 0 || a1 === 0 || routed >= 0)) {
        this.endTime = this.time;
        this.winner = routed >= 0 ? 1 - routed : a0 > 0 ? 0 : a1 > 0 ? 1 : 2; // 2 = mutual annihilation
        const c = this.center;
        if (routed >= 0) this.event(`${TM.TEAMS[routed].full} обращена в бегство`, routed, c && c[routed].x, c && c[routed].y, 'break');
        if (this.winner < 2) {
          this.event(`${TM.TEAMS[this.winner].full} побеждает!`, this.winner, c && c[this.winner].x, c && c[this.winner].y, 'win');
          if (this.center) this.snd('cheer', this.center[this.winner].x, this.center[this.winner].y);
        }
        else this.event('Взаимное уничтожение!', 0);
      }
      if (this.endTime && this.time - this.endTime > 2.2) this.state = 'over';
    }

    mvp() {
      let best = null;
      for (const u of this.units) if (!best || u.kills > best.kills || (u.kills === best.kills && u.dmg > best.dmg)) best = u;
      return best && best.kills > 0 ? best : null;
    }

    unitAt(x, y, r) {
      const n = this.grid.query(x, y, r + 16, buf);
      let best = null, bd = 1e9;
      for (let i = 0; i < n; i++) {
        const o = buf[i];
        if (o.state !== ALIVE) continue;
        const d = Math.hypot(o.x - x, o.y - y) - o.r;
        if (d < r && d < bd) { bd = d; best = o; }
      }
      return best;
    }
  }

  TM.Battle = Battle;
})(window.TM = window.TM || {});
