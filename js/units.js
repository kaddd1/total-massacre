// Unit factory and per-soldier behaviour: morale, keeping one's place in the ranks, local fighting.
// The regiment (js/tactics.js) decides where the formation goes; a soldier keeps to his slot and
// only fights enemies that come within a short leash of his place in the ranks.
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
      mode: 0, engagedT: 0, chargeImmune: 0,
      stunT: 0, deathT: 0, deathRot: 0,
      // regiment membership (set by TM.Tactics.build)
      reg: null, slot: 0, sdep: 0, slat: 0, rank: 0, contactT: -9, volleyAt: 0, volleyTarget: null,
    };
  }

  // ---------------- perception / decision (runs ~3 times per second) ----------------
  function think(u, B) {
    const d = u.def, R = u.reg;
    const el = Math.min(1, B.time - u.lastThink);
    u.lastThink = B.time;

    // a soldier only looks for fights within reach of his place in the ranks
    const leash = R ? TM.Tactics.leash(u) : 1e9;
    const sx = R ? R.slotX(u) : u.x, sy = R ? R.slotY(u) : u.y;
    const sense = R ? Math.max(MORALE_R, leash + d.reach + 40) : d.sense;
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
      if (R) {
        if (d.ranged) continue; // archers shoot on the regiment's command; daggers use nearEnemy
        const lim = leash + d.reach + u.r + o.r + 4;
        const ox = o.x - sx, oy = o.y - sy;
        if (ox * ox + oy * oy > lim * lim) continue;
      }

      let s = Math.sqrt(d2);
      if (d.prefer && d.prefer[o.type]) s -= d.prefer[o.type];
      if (!R && d.ranged) s += o.attackers * 25 + U.rand() * 50;
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
      if (R) {
        if (R.routing) dm -= 7;                                   // the regiment is running
        else if (!u.fleeing) {
          const ox = u.x - sx, oy = u.y - sy;
          if (R.discipline && ox * ox + oy * oy < 576) dm += 1.5; // shoulder to shoulder in the ranks
          dm -= R.flankHits * 0.9;                                // blows from the flank and the rear
          if (R.strength < 0.5) dm -= (0.5 - R.strength) * 8;     // the regiment is melting away
        }
      }
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
    if (R && d.ranged) {
      // a cornered archer draws his dagger; otherwise he aims where his regiment shoots
      u.target = near && Math.sqrt(nearD2) - u.r - near.r < d.reach + 3 ? near : (R.aim && R.aim.state === ALIVE ? R.aim : null);
      // contact = an enemy within shooting range (the march drums and the HUD stage go by it)
      if (u.target && Math.hypot(u.target.x - u.x, u.target.y - u.y) < d.ranged.range + 30) B.contact[u.team] = true;
      return;
    }
    if (best) {
      u.target = best;
      B.contact[u.team] = true;
    } else if (!R && (B.contact[u.team] || B.contact[1 - u.team] || B.time > 25)) {
      u.target = hunt(u, B);
    } else {
      u.target = null;
    }
  }

  // No regiment and no enemies around: pick the nearest from a random sample of the enemy army.
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
    u.chargeImmune -= dt; u.stunT -= dt;

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

    const R = u.reg;
    let t = u.target;
    if (t && t.state !== ALIVE) { t = u.target = null; u.thinkT = Math.min(u.thinkT, 0.05); }

    if (!R) return loose(u, B, t, speed, dt);
    u.mode = R.order === 'withdraw' ? 1 : 0;
    if (B.winner === u.team) {
      // the field is ours: stand in the ranks and cheer
      keepRank(u, R, R.slotX(u), R.slotY(u), speed);
      if (u.z <= 0 && u.type !== 'giant' && U.rand() < dt * 0.8) u.vz = 70 + U.rand() * 50;
      return;
    }
    if (d.ranged) return archer(u, B, R, t, speed);

    const sx = R.slotX(u), sy = R.slotY(u);
    if (t) {
      // a fight that would drag us out of the ranks is dropped
      const lim = TM.Tactics.leash(u) + d.reach + u.r + t.r + 18;
      const ox = t.x - sx, oy = t.y - sy;
      if (ox * ox + oy * oy > lim * lim) t = u.target = null;
    }
    if (R.role === 'cavalry' && R.order !== 'melee' && R.order !== 'hold') {
      // riding in formation; strike whoever comes within reach on the way
      ride(u, R, sx, sy, speed);
      if (t) {
        const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.r - t.r;
        if (gap <= d.reach) { u.contactT = B.time; if (u.atkCd <= 0 && u.atkT < 0) startAttack(u, t, gap); }
      }
      return;
    }
    if (t) return melee(u, B, t, speed, dt);
    keepRank(u, R, sx, sy, speed);
  }

  // walk to one's place in the ranks, keeping the regiment's pace and facing
  function keepRank(u, R, sx, sy, speed) {
    const dx = sx - u.x, dy = sy - u.y, dist = Math.hypot(dx, dy);
    let vx = R.vx + dx * 2.4, vy = R.vy + dy * 2.4;
    const l = Math.hypot(vx, vy);
    if (l > speed) { vx *= speed / l; vy *= speed / l; }
    u.desX = vx; u.desY = vy;
    // dress the ranks facing the enemy; turn round only to walk somewhere far
    if (dist > 26 && l > speed * 0.6) u.faceTo = Math.atan2(vy, vx);
    else u.faceTo = R.role === 'cavalry' && l > 25 ? Math.atan2(vy, vx) : R.angle;
  }

  function ride(u, R, sx, sy, speed) {
    const dx = sx - u.x, dy = sy - u.y;
    let vx = R.vx + dx * 3, vy = R.vy + dy * 3;
    const l = Math.hypot(vx, vy) || 1;
    if (l > speed) { vx *= speed / l; vy *= speed / l; }
    u.desX = vx; u.desY = vy;
    u.faceTo = l > 20 ? Math.atan2(vy, vx) : R.angle;
  }

  function melee(u, B, t, speed, dt) {
    const d = u.def;
    const dx = t.x - u.x, dy = t.y - u.y;
    const dist = Math.hypot(dx, dy) || 0.001;
    const nx = dx / dist, ny = dy / dist;
    const gap = dist - u.r - t.r;
    if (gap > d.reach) {
      let mx = nx, my = ny;
      if (gap < 70 && (!u.reg || u.reg.discipline === 0)) {
        // a mob spreads around its victim instead of queueing in a line
        mx += -ny * u.flankBias * 0.6; my += nx * u.flankBias * 0.6;
        const l = Math.hypot(mx, my); mx /= l; my /= l;
      }
      u.desX = mx * speed; u.desY = my * speed;
      u.faceTo = Math.atan2(u.desY, u.desX);
      if (u.atkT < 0) u.engagedT = Math.max(0, u.engagedT - dt);
    } else {
      u.contactT = B.time;
      u.faceTo = Math.atan2(ny, nx);
      if (u.type === 'spear' && gap < d.reach * 0.5) {
        // spearmen step back to keep the enemy at the tip of the spear
        u.desX = -nx * speed * 0.5; u.desY = -ny * speed * 0.5;
      } else {
        u.desX = nx * 4; u.desY = ny * 4;
      }
      u.engagedT += dt;
      if (u.atkCd <= 0 && u.atkT < 0) startAttack(u, t, gap);
    }
  }

  function archer(u, B, R, t, speed) {
    const d = u.def, r = d.ranged;
    const ne = u.nearEnemy;
    const neD = ne && ne.state === ALIVE ? Math.hypot(ne.x - u.x, ne.y - u.y) - u.r - ne.r : 1e9;
    if (neD <= d.reach + 1) {
      // cornered: stab with a dagger, still trying to slip away
      const ex = ne.x - u.x, ey = ne.y - u.y, l = Math.hypot(ex, ey) || 1;
      u.contactT = B.time;
      u.faceTo = Math.atan2(ey, ex);
      if (u.atkCd <= 0 && u.atkT < 0) startAttack(u, ne, neD);
      u.desX = -ex / l * speed * 0.35; u.desY = -ey / l * speed * 0.35;
      return;
    }
    // the regiment's volley: loose at the given mark
    if (u.volleyAt && B.time >= u.volleyAt) {
      const T = u.volleyTarget;
      u.volleyAt = 0;
      if (T && T.state === ALIVE && u.rangedCd <= 0.55) {
        const dist = Math.hypot(T.x - u.x, T.y - u.y);
        if (dist <= r.range + 35) {
          u.faceTo = Math.atan2(T.y - u.y, T.x - u.x);
          B.fireArrow(u, T, dist);
          u.rangedCd = r.cooldown * U.range(0.88, 0.98); // ready again for the next volley
          u.shotT = 0;
        }
      }
    }
    keepRank(u, R, R.slotX(u), R.slotY(u), speed);
    if (R.order === 'shoot' && t && t.state === ALIVE && Math.abs(u.desX) + Math.abs(u.desY) < speed * 0.8) u.faceTo = Math.atan2(t.y - u.y, t.x - u.x);
  }

  // fallback for a soldier without a regiment: the old free-for-all behaviour
  function loose(u, B, t, speed, dt) {
    const d = u.def;
    if (!t) {
      const m = B.march[u.team];
      if (m.x === 0 && m.y === 0) {
        if (B.winner === u.team && u.z <= 0 && u.type !== 'giant' && U.rand() < dt * 0.8) u.vz = 70 + U.rand() * 50;
        return;
      }
      u.desX = m.x * speed * 0.8; u.desY = m.y * speed * 0.8;
      u.faceTo = Math.atan2(m.y, m.x);
      return;
    }
    if (d.ranged) {
      const dist = Math.hypot(t.x - u.x, t.y - u.y);
      u.faceTo = Math.atan2(t.y - u.y, t.x - u.x);
      if (dist > d.ranged.range) { u.desX = (t.x - u.x) / dist * speed; u.desY = (t.y - u.y) / dist * speed; return; }
      if (u.rangedCd <= 0) { B.fireArrow(u, t, dist); u.rangedCd = d.ranged.cooldown * U.range(0.85, 1.25); u.shotT = 0; }
      return;
    }
    melee(u, B, t, speed, dt);
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
