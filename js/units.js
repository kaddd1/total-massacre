// Unit factory and per-unit autonomous behaviour (targeting, movement, morale).
(function (TM) {
  'use strict';
  const U = TM.U;

  const ALIVE = 0, DYING = 1, DEAD = 2, ESCAPED = 3;
  const MORALE_R = 90;
  const buf = [];

  function create(id, team, type, x, y) {
    const d = TM.UNIT_TYPES[type];
    const dir = TM.TEAMS[team].dir;
    return {
      id, team, type, def: d, idx: 0,
      x, y, vx: 0, vy: 0, kx: 0, ky: 0, z: 0, vz: 0,
      desX: 0, desY: 0,
      facing: dir > 0 ? 0 : Math.PI, faceTo: dir > 0 ? 0 : Math.PI,
      hp: d.hp, maxHp: d.hp, r: d.radius, mass: d.mass,
      state: ALIVE,
      target: null, thinkT: U.rand() * 0.4, lastThink: 0,
      atkCd: U.rand() * 0.6, atkT: -1, atkDone: false, atkTarget: null,
      rangedCd: 0.3 + U.rand() * 1.4, shotT: 9,
      morale: U.range(88, 100), bravery: (d.bravery || 1) * U.range(0.8, 1.25), fleeing: false,
      fleeX: -dir, fleeY: 0,
      nearEnemy: null, nearEnemyD: 1e9,
      hitFlash: 0, walk: U.rand() * 6.28, moveAmt: 0,
      speedMul: U.range(0.9, 1.1), flankBias: U.gauss() * 0.7,
      kills: 0, dmg: 0, attackers: 0,
      mode: 0, wheelX: 0, wheelY: 0, wheelT: 0, engagedT: 0, chargeCd: 0, chargeImmune: 0,
      stunT: 0, deathT: 0, deathRot: 0,
    };
  }

  // ---------------- perception / decision (runs ~3 times per second) ----------------
  function think(u, B) {
    const d = u.def;
    const el = Math.min(1, B.time - u.lastThink);
    u.lastThink = B.time;

    const sense = d.sense;
    const n = B.grid.query(u.x, u.y, sense, buf);
    let best = null, bestScore = 1e9;
    let allies = 0, enemies = 0, fleeingAllies = 0, terror = 0;
    let ex = 0, ey = 0, ec = 0, nearD2 = 1e18, near = null;
    const s2 = sense * sense, m2 = MORALE_R * MORALE_R;

    for (let i = 0; i < n; i++) {
      const o = buf[i];
      if (o === u) continue;
      const dx = o.x - u.x, dy = o.y - u.y;
      const d2 = dx * dx + dy * dy;
      if (o.team === u.team) {
        if (d2 < m2) { if (o.fleeing) fleeingAllies++; else allies += o.def.fearless ? 4 : 1; }
        continue;
      }
      if (d2 > s2) continue;
      if (d2 < m2) {
        enemies += o.fleeing ? 0.3 : (o.def.fearless ? 4 : o.type === 'knight' ? 2 : 1);
        ex += o.x; ey += o.y; ec++;
        if (o.def.terror && d2 < 4900) terror += o.def.terror;
      }
      if (d2 < nearD2) { nearD2 = d2; near = o; }
      if (u.fleeing) continue;

      let s = Math.sqrt(d2);
      if (d.prefer && d.prefer[o.type]) s -= d.prefer[o.type];
      if (d.ranged) s += o.attackers * 25 + U.rand() * 50;
      else s += o.attackers * 9;
      if (o.fleeing) s += 30;
      if (o === u.target) s -= 25;
      if (s < bestScore) { bestScore = s; best = o; }
    }
    u.nearEnemy = near;
    u.nearEnemyD = near ? Math.sqrt(nearD2) : 1e9;

    // ----- morale -----
    if (B.opts.morale && !d.fearless) {
      let dm = 0;
      const lossR = B.lossRatio(u.team);
      if (enemies === 0) dm += u.fleeing ? (lossR > 0.6 ? 1 : 3) : 6;
      else if (enemies > allies + 1) dm -= (enemies - allies - 1) * 1.3;
      else dm += 2;
      const hpR = u.hp / u.maxHp;
      if (hpR < 0.35) dm -= (0.35 - hpR) * 25;
      dm -= Math.min(fleeingAllies, 6) * 1.2;
      dm -= terror;
      if (lossR > 0.55) dm -= (lossR - 0.55) * 22;
      dm *= dm < 0 ? 1 / u.bravery : u.bravery;
      u.morale = U.clamp(u.morale + dm * el, 0, 100);

      if (!u.fleeing && u.morale < 14) {
        u.fleeing = true;
        u.target = null;
        u.atkT = -1;
        B.onFlee(u);
      } else if (u.fleeing && u.morale > 50 && enemies === 0) {
        u.fleeing = false;
        u.morale = 60;
        B.onRally(u);
      }
    }

    if (u.fleeing) {
      const home = B.home[u.team];
      let fx = home.x * 0.9, fy = home.y * 0.9;
      if (ec > 0) {
        // run away from the local enemy centroid
        const ax = u.x - ex / ec, ay = u.y - ey / ec;
        const l = Math.hypot(ax, ay) || 1;
        fx += ax / l; fy += ay / l;
      }
      fy += U.gauss() * 0.15;
      const l = Math.hypot(fx, fy) || 1;
      u.fleeX = fx / l; u.fleeY = fy / l;
      return;
    }

    // ----- targeting -----
    if (best) {
      u.target = best;
      B.contact[u.team] = true;
    } else if (B.contact[u.team] || B.contact[1 - u.team] || B.time > 25) {
      u.target = hunt(u, B);
    } else {
      u.target = null;
    }
  }

  // No enemies around: pick the nearest from a random sample of the enemy army.
  function hunt(u, B) {
    const list = B.alive[1 - u.team];
    const len = list.length;
    if (!len) return null;
    let best = null, bd = 1e18;
    const samples = Math.min(len, 12);
    for (let k = 0; k < samples; k++) {
      const o = len <= 12 ? list[k] : list[(U.rand() * len) | 0];
      const dx = o.x - u.x, dy = o.y - u.y;
      const d2 = dx * dx + dy * dy + (o.fleeing ? 40000 : 0);
      if (d2 < bd) { bd = d2; best = o; }
    }
    return best;
  }

  // ---------------- per-tick behaviour ----------------
  function update(u, B, dt) {
    const d = u.def;
    u.atkCd -= dt; u.rangedCd -= dt; u.hitFlash -= dt; u.shotT += dt;
    u.chargeCd -= dt; u.chargeImmune -= dt; u.stunT -= dt;

    if (u.atkT >= 0) {
      u.atkT += dt;
      if (!u.atkDone && u.atkT >= d.windup) { u.atkDone = true; B.resolveMelee(u); }
      if (u.atkT >= d.windup + 0.25) u.atkT = -1;
    }

    u.thinkT -= dt;
    if (u.thinkT <= 0) {
      u.thinkT = 0.28 + U.rand() * 0.14;
      think(u, B);
    }

    u.desX = 0; u.desY = 0;
    if (u.z > 0.5 || u.stunT > 0) return;

    const speed = d.speed * u.speedMul;

    if (u.fleeing) {
      u.desX = u.fleeX * speed * 1.1;
      u.desY = u.fleeY * speed * 1.1;
      u.faceTo = Math.atan2(u.desY, u.desX);
      return;
    }

    let t = u.target;
    if (t && t.state !== ALIVE) { t = u.target = null; u.thinkT = Math.min(u.thinkT, 0.05); }

    if (!t) {
      // march with the army, keeping formation
      const m = B.march[u.team];
      if (m.x === 0 && m.y === 0) {
        // no enemies left: celebrate
        if (B.winner === u.team && u.z <= 0 && u.type !== 'giant' && U.rand() < dt * 0.8) u.vz = 70 + U.rand() * 50;
        return;
      }
      const ms = u.type === 'knight' ? speed * 0.5 : speed * 0.8;
      u.desX = m.x * ms; u.desY = m.y * ms;
      u.faceTo = Math.atan2(m.y, m.x);
      u.engagedT = 0;
      return;
    }

    if (u.type === 'knight' && u.mode === 1) return knightWheel(u, B, dt, speed);

    const dx = t.x - u.x, dy = t.y - u.y;
    const dist = Math.hypot(dx, dy) || 0.001;
    const nx = dx / dist, ny = dy / dist;
    const gap = dist - u.r - t.r;

    if (d.ranged) return archer(u, B, t, dist, gap, nx, ny, speed);

    if (gap > d.reach) {
      let mx = nx, my = ny;
      if (gap < 70) {
        // spread around the target instead of queueing in a line
        mx += -ny * u.flankBias * 0.6; my += nx * u.flankBias * 0.6;
        const l = Math.hypot(mx, my); mx /= l; my /= l;
      }
      u.desX = mx * speed; u.desY = my * speed;
      u.faceTo = Math.atan2(u.desY, u.desX);
      if (u.atkT < 0) u.engagedT = Math.max(0, u.engagedT - dt);
    } else {
      u.faceTo = Math.atan2(ny, nx);
      if (u.type === 'spear' && gap < d.reach * 0.5) {
        // spearmen step back to keep the enemy at the tip of the spear
        u.desX = -nx * speed * 0.5; u.desY = -ny * speed * 0.5;
      } else {
        u.desX = nx * 4; u.desY = ny * 4;
      }
      u.engagedT += dt;
      if (u.atkCd <= 0 && u.atkT < 0) startAttack(u, t, gap);

      if (u.type === 'knight' && u.engagedT > 3 && u.chargeCd <= 0 && u.hp > u.maxHp * 0.3) {
        // pull back for another charge
        u.mode = 1;
        const side = U.gauss() * 0.8;
        u.wheelX = U.clamp(u.x - nx * 180 - ny * side * 80, 40, TM.CONFIG.WORLD_W - 40);
        u.wheelY = U.clamp(u.y - ny * 180 + nx * side * 80, 40, TM.CONFIG.WORLD_H - 40);
        u.wheelT = 2.6;
      }
    }
  }

  function knightWheel(u, B, dt, speed) {
    u.wheelT -= dt;
    const dx = u.wheelX - u.x, dy = u.wheelY - u.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (dist < 22 || u.wheelT <= 0) {
      u.mode = 0; u.chargeCd = 6; u.engagedT = 0; u.thinkT = 0;
      return;
    }
    u.desX = dx / dist * speed; u.desY = dy / dist * speed;
    u.faceTo = Math.atan2(dy, dx);
  }

  function archer(u, B, t, dist, gap, nx, ny, speed) {
    const d = u.def, r = d.ranged;
    const ne = u.nearEnemy;
    const neD = ne && ne.state === ALIVE ? Math.hypot(ne.x - u.x, ne.y - u.y) - u.r - ne.r : 1e9;

    if (neD <= d.reach + 1) {
      // cornered: stab with a dagger
      const ex = ne.x - u.x, ey = ne.y - u.y, l = Math.hypot(ex, ey) || 1;
      u.faceTo = Math.atan2(ey, ex);
      if (u.atkCd <= 0 && u.atkT < 0) startAttack(u, ne, neD);
      // still try to slip away
      u.desX = -ex / l * speed * 0.35; u.desY = -ey / l * speed * 0.35;
      return;
    }
    if (neD < r.minRange && !ne.def.ranged && !ne.fleeing) {
      // kite: back off away from the threat, drifting home
      const ex = u.x - ne.x, ey = u.y - ne.y, l = Math.hypot(ex, ey) || 1;
      const home = B.home[u.team];
      let mx = ex / l + home.x * 0.3, my = ey / l;
      if (home.y) my += home.y * 0.3;
      const ml = Math.hypot(mx, my); mx /= ml; my /= ml;
      u.desX = mx * speed; u.desY = my * speed;
      u.faceTo = Math.atan2(my, mx);
      return;
    }
    if (dist > r.range) {
      u.desX = nx * speed; u.desY = ny * speed;
      u.faceTo = Math.atan2(ny, nx);
      return;
    }
    u.faceTo = Math.atan2(ny, nx);
    if (u.rangedCd <= 0 && Math.abs(U.angDiff(u.facing, u.faceTo)) < 0.4) {
      B.fireArrow(u, t, dist);
      u.rangedCd = r.cooldown * U.range(0.85, 1.25);
      u.shotT = 0;
    }
  }

  function startAttack(u, t, gap) {
    const d = u.def;
    u.atkT = 0;
    u.atkDone = false;
    u.atkTarget = t;
    u.atkCd = d.cooldown * U.range(0.85, 1.2);
    // enemy got inside the spear's reach: clumsy
    if (u.type === 'spear' && gap < d.reach * 0.3) u.atkCd *= 1.3;
  }

  TM.Units = { create, update, think, ALIVE, DYING, DEAD, ESCAPED };
})(window.TM = window.TM || {});
