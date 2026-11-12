// Unit factory and per-soldier behaviour: morale, keeping one's place in the ranks, local fighting.
// The regiment (js/tactics.js) decides where the formation goes; a soldier keeps to his slot and
// only fights enemies that come within a short leash of his place in the ranks.
(function (TM) {
  'use strict';
  const U = TM.U;

  const ALIVE = 0, DYING = 1, DEAD = 2, ESCAPED = 3;
  const MORALE_R = 90;
  const TERROR_R = 95;     // a giant frightens the men within this distance (more the closer it is)
  const buf = [];

  // ---------------- the general's presence ----------------
  // Radius of each archetype's influence and what it does to the men inside it (see think()).
  const AURA = { marshal: 210, warlord: 110, tactician: 200 };
  function generalNear(u, B) {
    const g = B.generals && B.generals[u.team];
    if (!g || g === u || g.state !== ALIVE) return null;
    const dx = g.x - u.x, dy = g.y - u.y, r = AURA[g.genKind];
    return dx * dx + dy * dy < r * r ? g.genKind : null;
  }

  // ---------------- stamina ----------------
  // 1 = fresh, 0 = spent. Running flat out (faster than a formation's marching pace), fleeing and
  // every blow cost breath; walking and standing give it back, slowly while the enemy is close.
  // Below half, a tired man is slower and strikes less often (at worst 70% of his speed and a third
  // slower blows): he never stops, but he can no longer outrun pursuit or kite for ever.
  const SPRINT = 0.92;     // fraction of one's own top speed above which running costs breath
  function tiredness(u) { const f = u.sta >= 0.5 ? 1 : u.sta / 0.5; return f; }
  function speedK(u) { return 0.7 + 0.3 * tiredness(u); }
  function breathe(u, B, sp, dt) {
    const d = u.def, top = d.speed * u.speedMul, R = u.reg;
    let s = sp / top;
    // in his place in the ranks a man goes at the pace of his regiment: the small corrections that
    // keep the ranks dressed are not a run
    if (s > 0.6 && R && !u.fleeing && !d.mounted) {
      const dx = u.x - (R.ax + R.cos * u.sdep - R.sin * u.slat), dy = u.y - (R.ay + R.sin * u.sdep + R.cos * u.slat);
      if (dx * dx + dy * dy < 144) { const rs = Math.sqrt(R.vx * R.vx + R.vy * R.vy) / top; if (rs < s) s = rs; }
    }
    let e = s > SPRINT ? Math.min(u.fleeing ? 0.6 : 1.2, (s - SPRINT) / (1 - SPRINT)) : 0;  // a man running for his life paces himself a little
    // a skirmish run back is flat out for the whole regiment, a charge half that
    const o = R && !u.fleeing && s > 0.6 ? R.order : '';
    if (o === 'fallback') e = Math.max(e, 1); else if (o === 'charge') e = Math.max(e, 0.35);
    if (e > 0) {
      u.sta -= e * dt / (6.5 * d.endurance);
    } else {
      // standing still out of danger he gets his breath back in ~20 s; with the enemy close only slowly
      const pressed = u.nearEnemyD < 150 || B.time - u.contactT < 1;
      const rate = s < 0.4 ? (pressed ? 1 / 60 : 1 / 18) : (pressed ? 1 / 120 : 1 / 40);
      u.sta += rate * d.recovery * dt;
    }
    if (u.sta > 1) u.sta = 1; else if (u.sta < 0) u.sta = 0;
  }

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
      blockT: -9, // when a shield last caught an arrow (read by the renderer only)
      // regiment membership (set by TM.Tactics.build)
      reg: null, slot: 0, sdep: 0, slat: 0, rank: 0, contactT: -9, volleyAt: 0, volleyTarget: null,
      sta: 1,                  // stamina (see breathe)
      shock: 0, seen: 0,       // fright from comrades dying around, still to sink in; deaths witnessed
      facedT: 0,               // seconds spent face to face with a terror (one gets used even to giants)
      rage: 0,                 // berserkers: fury from wounds and kills (0..1)
      inspired: false,         // fighting next to a warlord
      genKind: '',             // generals: archetype
      ammo: d.ranged && d.ranged.ammo ? d.ranged.ammo : Infinity,   // a horse archer's quiver
    };
  }

  // ---------------- perception / decision (runs ~3 times per second) ----------------
  function think(u, B) {
    const d = u.def, R = u.reg;
    const el = Math.min(1, B.time - u.lastThink);
    u.lastThink = B.time;

    // a soldier only looks for fights within reach of his place in the ranks
    const leash = TM.Tactics.leash(u);
    const sx = R.slotX(u), sy = R.slotY(u);
    const sense = Math.max(MORALE_R, leash + d.reach + 40);
    const shooter = d.ranged && !R.spent;   // horse archers out of arrows look for a fight like any rider
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
        enemies += o.fleeing ? 0.3 : (o.def.fearless ? 4 : o.def.mounted ? 2 : 1);
        ex += o.x; ey += o.y; ec++;
      }
      if (o.def.terror && d2 < TERROR_R * TERROR_R) {
        terror += o.def.terror * (1 - Math.sqrt(d2) / TERROR_R * 0.6) * (0.35 + 0.65 * o.hp / o.maxHp);
      }
      if (d2 < nearD2) { nearD2 = d2; near = o; }
      if (u.fleeing || shooter) continue; // archers shoot on the regiment's command; daggers use nearEnemy
      const lim = leash + d.reach + u.r + o.r + 4;
      const ox = o.x - sx, oy = o.y - sy;
      if (ox * ox + oy * oy > lim * lim) continue;

      let s = Math.sqrt(d2) + o.attackers * 9;
      if (d.prefer && d.prefer[o.type]) s -= d.prefer[o.type];
      if (o.fleeing) s += 30;
      if (o === u.target) s -= 25;
      if (s < bestScore) { bestScore = s; best = o; }
    }
    u.nearEnemy = near;
    u.nearEnemyD = near ? Math.sqrt(nearD2) : 1e9;

    const aura = generalNear(u, B);
    u.inspired = aura === 'warlord';
    if (d.rage) {
      // fury: fed by wounds and blows (battle.js), fading when there is nobody to fight; a badly
      // wounded berserker is always in a rage
      u.rage = Math.max(u.rage * Math.exp(-el / (best ? 8 : 3)), 1 - u.hp / u.maxHp);
    }

    // ----- morale -----
    if (B.opts.morale && !d.fearless) {
      let dm = 0;
      if (aura === 'marshal') { dm += u.fleeing ? 10 : 3; terror *= 0.5; }
      else if (aura === 'warlord') dm += u.fleeing ? 5 : 1.5;
      else if (aura === 'tactician') dm += u.fleeing ? 3 : 0.8;
      // berserkers fear nothing while they still have breath to fight
      const furious = d.rage && u.sta > 0.25 && R.n >= 4 && allies >= 2;   // the frenzy of a pack, not of a lone man
      if (furious) terror = 0;
      // the death of comrades sinks in over a few seconds instead of all at once: a massacre around
      // a man wears him down steadily (at most ~5 points a second) rather than in one blow. Nothing is
      // forgotten, it only takes time, and in that time the men can still turn the fight (a fallen
      // giant lifts the dread, battle.js)
      if (u.shock > 0.01) {
        const take = Math.min(u.shock, 5 * el + 0.4);
        u.morale -= aura === 'marshal' ? take * 0.5 : take; u.shock -= take;
      }
      const lossR = B.lossRatio(u.team);
      if (enemies === 0) dm += u.fleeing ? (lossR > 0.6 ? 1 : 3) : 6;
      else if (enemies > allies + 1) dm -= (enemies - allies - 1) * 1.3;
      else dm += 2;
      const hpR = u.hp / u.maxHp;
      if (hpR < 0.35) dm -= (0.35 - hpR) * 25;
      dm -= Math.min(fleeingAllies, 6) * 1.2;
      if (terror > 0) {
        // shoulder to shoulder in a formed regiment the monster is faced, not fled; and after a
        // while face to face with it, one learns that it bleeds too
        u.facedT += el;
        const ranks = R.discipline && !R.routing && allies >= 8 ? 0.6 : 1;
        dm -= terror * ranks / (1 + u.facedT / 15);
      }
      if (lossR > 0.55) dm -= (lossR - 0.55) * 22;
      if (R.routing) dm -= 7;
      else if (!u.fleeing) {
        const ox = u.x - sx, oy = u.y - sy;
        if (R.discipline && ox * ox + oy * oy < 576) dm += 1.5; // shoulder to shoulder in the ranks
        dm -= R.flankHits * 0.9;                                // blows from the flank and the rear
        if (R.strength < 0.5) dm -= (0.5 - R.strength) * 8;     // the regiment is melting away
      }
      // a man out of breath takes heart more slowly
      dm *= dm < 0 ? 1 / u.bravery : u.bravery * (0.6 + 0.4 * tiredness(u));
      u.morale = U.clamp(u.morale + dm * el, furious ? 30 : 0, 100);

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
    if (shooter) {
      // a cornered archer draws his dagger; otherwise he aims where his regiment shoots
      const nd = near ? Math.sqrt(nearD2) - u.r - near.r : 1e9;
      u.target = near && (nd < d.reach + 3 || (R.order === 'stand' && nd < 22)) ? near : (R.aim && R.aim.state === ALIVE ? R.aim : null);
      // contact = an enemy within shooting range (the march drums and the HUD stage go by it)
      if (u.target && Math.hypot(u.target.x - u.x, u.target.y - u.y) < d.ranged.range + 30) B.contact[u.team] = true;
      return;
    }
    u.target = best;
    if (best) B.contact[u.team] = true;
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

    const speed = d.speed * u.speedMul * speedK(u) * (1 + u.rage * 0.1);

    if (u.fleeing) {
      u.desX = u.fleeX * speed * 1.1;
      u.desY = u.fleeY * speed * 1.1;
      u.faceTo = Math.atan2(u.desY, u.desX);
      return;
    }

    const R = u.reg;
    let t = u.target;
    if (t && t.state !== ALIVE) { t = u.target = null; u.thinkT = Math.min(u.thinkT, 0.05); }
    u.mode = R.order === 'withdraw' ? 1 : 0;
    if (B.winner === u.team) {
      // the field is ours: stand in the ranks and cheer
      keepRank(u, R, R.slotX(u), R.slotY(u), speed);
      if (u.z <= 0 && u.type !== 'giant' && U.rand() < dt * 0.8) u.vz = 70 + U.rand() * 50;
      return;
    }
    if (R.role === 'skirmisher' && !R.spent) return skirmisher(u, B, R, t, speed);
    if (d.ranged) return archer(u, B, R, t, speed);

    const sx = R.slotX(u), sy = R.slotY(u);
    if (t) {
      // a fight that would drag us out of the ranks is dropped
      const lim = TM.Tactics.leash(u) + d.reach + u.r + t.r + 18;
      const ox = t.x - sx, oy = t.y - sy;
      if (ox * ox + oy * oy > lim * lim) t = u.target = null;
    }
    if (R.role === 'general' && R.order !== 'lead') {
      // the general rides where he is needed and only strikes whoever gets in his way
      ride(u, R, sx, sy, speed);
      if (t) {
        const gap = Math.hypot(t.x - u.x, t.y - u.y) - u.r - t.r;
        if (gap <= d.reach) { u.contactT = B.time; if (u.atkCd <= 0 && u.atkT < 0) startAttack(u, t, gap); }
      }
      return;
    }
    if ((R.role === 'cavalry' || R.role === 'skirmisher') && R.order !== 'melee' && R.order !== 'hold') {
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
      // stepping up to the next foe is a quick walk, not a sprint (saves breath for a long fight);
      // only a man left far behind runs
      const pace = gap > 40 ? 1 : 0.88;
      u.desX = mx * speed * pace; u.desY = my * speed * pace;
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

  // Horse archers ride with their regiment and shoot at will from the saddle, less accurately on
  // the move; caught at close quarters they cut their way out.
  function skirmisher(u, B, R, t, speed) {
    const d = u.def, r = d.ranged;
    const ne = u.nearEnemy;
    const neD = ne && ne.state === ALIVE ? Math.hypot(ne.x - u.x, ne.y - u.y) - u.r - ne.r : 1e9;
    if (R.order === 'melee' && t && t.state === ALIVE) return melee(u, B, t, speed, 0);
    ride(u, R, R.slotX(u), R.slotY(u), speed);
    if (neD <= d.reach + 1) {
      u.contactT = B.time;
      if (u.atkCd <= 0 && u.atkT < 0) startAttack(u, ne, neD);
      return;
    }
    if (u.rangedCd > 0 || u.atkT >= 0 || u.ammo <= 0) return;
    let T = R.aim && R.aim.state === ALIVE ? R.aim : null;
    let dist = T ? Math.hypot(T.x - u.x, T.y - u.y) : 1e9;
    if (dist > r.range && ne && ne.state === ALIVE && u.nearEnemyD <= r.range) { T = ne; dist = u.nearEnemyD; }
    if (!T || dist > r.range || !TM.Tactics.clearShot(B, T, u.team)) return;
    const moving = Math.hypot(u.vx, u.vy) > d.speed * 0.4;
    B.fireArrow(u, T, dist, moving ? 1.4 : 1);
    u.ammo--;
    u.rangedCd = r.cooldown * U.range(0.9, 1.15);
    u.shotT = 0;
  }

  function archer(u, B, R, t, speed) {
    const d = u.def, r = d.ranged;
    const ne = u.nearEnemy;
    const neD = ne && ne.state === ALIVE ? Math.hypot(ne.x - u.x, ne.y - u.y) - u.r - ne.r : 1e9;
    // the regiment makes a stand: the men the enemy reached fight hand to hand
    if (R.order === 'stand' && t && t === ne && neD < 22) return melee(u, B, t, speed, 0);
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
          u.sta = Math.max(0, u.sta - 0.012);            // drawing a war bow is work too
          u.shotT = 0;
        }
      }
    }
    keepRank(u, R, R.slotX(u), R.slotY(u), speed);
    if (R.order === 'shoot' && t && t.state === ALIVE && Math.abs(u.desX) + Math.abs(u.desY) < speed * 0.8) u.faceTo = Math.atan2(t.y - u.y, t.x - u.x);
  }

  function startAttack(u, t, gap) {
    const d = u.def;
    u.atkT = 0;
    u.atkDone = false;
    u.atkTarget = t;
    u.atkCd = d.cooldown * U.range(0.85, 1.2) * (1 + 0.35 * (1 - tiredness(u)))  // tired arms strike slower
      * (1 - 0.25 * u.rage) * (u.inspired ? 0.95 : 1);
    u.sta = Math.max(0, u.sta - 0.02 / d.endurance);
    // enemy got inside the spear's reach: clumsy
    if (u.type === 'spear' && gap < d.reach * 0.3) u.atkCd *= 1.3;
  }

  TM.Units = { create, update, think, breathe, speedK, tiredness, ALIVE, DYING, DEAD, ESCAPED };
})(window.TM = window.TM || {});
