// Tactical AI: regiments (отряды) with formations, orders and army command.
//
// Every soldier belongs to a regiment: an editor group, or a block of an automatic formation split
// into regiment-sized parts. A regiment has an anchor point, a facing and a slot for each soldier
// (his offset from the anchor in the starting layout). Five times a second every regiment decides an
// order — advance, charge, engage, brace, shoot, fall back, flank, withdraw, rally… — and its anchor
// moves accordingly. Soldiers keep to their slots and only fight enemies that come within a short
// leash of their place in the ranks; places of the fallen are filled from the rear ranks, so lines
// thin out instead of dissolving into a crowd. Twice a second each army's "general" sets the common
// pace of the battle line, the stance (attack / hold under the cover of archers) and commits reserves.
//
// Determinism: all decisions run at fixed simulation times in fixed regiment order; the only source
// of randomness is the seeded TM.U.rand.
(function (TM) {
  'use strict';
  const U = TM.U;
  const ALIVE = 0;
  const THINK = 0.2;                         // regiment decision period, s
  const NAME = { sword: 'мечники', spear: 'копейщики', archer: 'лучники', knight: 'рыцари', giant: 'великаны' };
  const REG_W = { sword: 240, spear: 240, archer: 280, knight: 140, giant: 260 }; // target frontage of a regiment
  const MIN_REG = { sword: 12, spear: 12, archer: 12, knight: 5, giant: 1 };      // smallest regiment when splitting
  const HORDE_REG = 40;                      // men per regiment in a horde
  const TWO_PI = Math.PI * 2;

  // ---------------------------------------------------------------- partition of a deployment
  // spots: [{type, x, y, blk}] in world coordinates; returns a regiment index for every spot.
  // Blocks are split along the front into parts of about REG_W pixels (and at least MIN_REG men).
  function partition(spots, angle, horde) {
    const fx = Math.cos(angle), fy = Math.sin(angle);
    const blocks = new Map();
    spots.forEach((s, i) => { const k = s.blk; if (!blocks.has(k)) blocks.set(k, []); blocks.get(k).push(i); });
    const reg = new Array(spots.length);
    let next = 0;
    for (const idx of blocks.values()) {
      const type = spots[idx[0]].type;
      const lat = (i) => -fy * spots[i].x + fx * spots[i].y;
      let lo = Infinity, hi = -Infinity;
      for (const i of idx) { const l = lat(i); if (l < lo) lo = l; if (l > hi) hi = l; }
      let k = horde ? Math.round(idx.length / HORDE_REG) : Math.round((hi - lo) / REG_W[type]);
      k = U.clamp(k, 1, 8);
      k = Math.max(1, Math.min(k, Math.floor(idx.length / MIN_REG[type])));
      const sorted = idx.slice().sort((a, b) => lat(a) - lat(b) || a - b);
      for (let j = 0; j < sorted.length; j++) reg[sorted[j]] = next + Math.min(k - 1, Math.floor(j * k / sorted.length));
      next += k;
    }
    return reg;
  }

  // ---------------------------------------------------------------- regiment
  class Regiment {
    constructor(id, team, type, members, angle, doctrine) {
      this.id = id; this.team = team; this.type = type; this.def = TM.UNIT_TYPES[type];
      this.name = NAME[type];
      this.doctrine = doctrine;                       // line | spearhead | horde
      this.discipline = doctrine === 'horde' ? 0 : 1;
      this.role = type === 'archer' ? 'missile' : type === 'knight' ? 'cavalry' : type === 'giant' ? 'monster' : 'front';
      this.members = members; this.n0 = members.length;
      this.spacing = TM.Formations.spacing(type);
      let ax = 0, ay = 0;
      for (const u of members) { ax += u.x; ay += u.y; }
      this.ax = ax / members.length; this.ay = ay / members.length;
      this.angle = angle; this.cos = Math.cos(angle); this.sin = Math.sin(angle);
      this.vx = 0; this.vy = 0;
      // slots = starting offsets in the regiment frame (dep: forward, lat: to the right)
      this.slots = members.map((u) => {
        const dx = u.x - this.ax, dy = u.y - this.ay;
        return { dep: dx * this.cos + dy * this.sin, lat: -dx * this.sin + dy * this.cos, rank: 0 };
      });
      let maxDep = -Infinity;
      for (const s of this.slots) maxDep = Math.max(maxDep, s.dep);
      for (const s of this.slots) s.rank = Math.max(0, Math.round((maxDep - s.dep) / this.spacing));
      this.prio = this.slots.map((_, i) => i).sort((a, b) => this.slots[a].rank - this.slots[b].rank || Math.abs(this.slots[a].lat) - Math.abs(this.slots[b].lat) || a - b);
      members.forEach((u, i) => { u.reg = this; this.setSlot(u, i); });
      // speeds
      this.maxSpeed = this.def.speed * (this.role === 'cavalry' ? 1 : this.role === 'monster' ? 0.9 : 0.82);
      this.speed = 0;
      this.goalX = this.ax; this.goalY = this.ay; this.goalAngle = angle;
      // state
      this.order = 'hold'; this.orderT = 0;
      this.target = null;
      this.routing = false; this.alive = members.length; this.n = members.length; this.fleeing = 0;
      this.strength = 1; this.lag = 0; this.engaged = 0; this.engagedT = 0; this.cx = this.ax; this.cy = this.ay;
      this.halfW = 10; this.front = 0; this.back = 0; this.radius = 10;
      this.flankHits = 0; this.volleyT = 0; this.phaseT = 0; this.waypoint = null;
      this.compactCount = -1; this.supportOf = null; this.supOff = null; this.events = {};
      this.braced = false;
    }

    setSlot(u, i) { const s = this.slots[i]; u.slot = i; u.sdep = s.dep; u.slat = s.lat; u.rank = s.rank; }
    // world position of a soldier's place in the ranks
    slotX(u) { return this.ax + this.cos * u.sdep - this.sin * u.slat; }
    slotY(u) { return this.ay + this.sin * u.sdep + this.cos * u.slat; }
    get fx() { return this.cos; }
    get fy() { return this.sin; }

    // Fill the places of the fallen from the rear: the first m slots (front ranks, centre first)
    // are given to the m standing soldiers, each slot to the nearest soldier not yet placed.
    compact() {
      const act = [];
      for (const u of this.members) if (u.state === ALIVE && !u.fleeing) act.push(u);
      if (act.length === this.compactCount) return;
      this.compactCount = act.length;
      const used = new Uint8Array(act.length);
      for (let k = 0; k < act.length; k++) {
        const si = this.prio[k], s = this.slots[si];
        const px = this.ax + this.cos * s.dep - this.sin * s.lat, py = this.ay + this.sin * s.dep + this.cos * s.lat;
        let best = -1, bd = Infinity;
        for (let j = 0; j < act.length; j++) {
          if (used[j]) continue;
          const d = (act[j].x - px) * (act[j].x - px) + (act[j].y - py) * (act[j].y - py);
          if (d < bd) { bd = d; best = j; }
        }
        used[best] = 1;
        this.setSlot(act[best], si);
      }
    }

    // summary of the regiment state, recomputed every decision
    survey(B) {
      let cx = 0, cy = 0, n = 0, alive = 0, flee = 0, lag = 0, eng = 0, front = -Infinity, back = Infinity, halfW = 0, fx = 0, fy = 0;
      for (const u of this.members) {
        if (u.state !== ALIVE) continue;
        alive++;
        if (u.fleeing) { flee++; fx += u.x; fy += u.y; continue; }
        n++; cx += u.x; cy += u.y;
        lag += Math.hypot(u.x - this.slotX(u), u.y - this.slotY(u));
        if (B.time - u.contactT < 0.6) eng++;
        if (u.sdep > front) front = u.sdep;
        if (u.sdep < back) back = u.sdep;
        if (Math.abs(u.slat) > halfW) halfW = Math.abs(u.slat);
      }
      this.alive = alive; this.n = n; this.fleeing = flee;
      if (flee) { this.fcx = fx / flee; this.fcy = fy / flee; }
      this.strength = alive / this.n0;
      if (n) {
        this.cx = cx / n; this.cy = cy / n; this.lag = lag / n; this.engaged = eng / n;
        this.front = front + this.spacing / 2; this.back = back - this.spacing / 2; this.halfW = halfW + this.spacing / 2;
        this.radius = Math.hypot(this.halfW, (this.front - this.back) / 2);
      } else { this.engaged = 0; this.lag = 0; }
      this.engagedT = this.engaged > 0.15 ? this.engagedT + THINK : 0;
    }

    frontX() { return this.ax + this.cos * this.front; }
    frontY() { return this.ay + this.sin * this.front; }
    active() { return this.n > 0 && !this.routing; }

    // anchor motion, every simulation tick
    move(dt) {
      let sp = this.speed;
      if (sp > 0 && this.role !== 'cavalry') {
        // don't run away from the men: a stretched formation waits for its ranks
        if (this.lag > 42) sp = 0; else if (this.lag > 22) sp *= 0.45;
      }
      const dx = this.goalX - this.ax, dy = this.goalY - this.ay, dist = Math.hypot(dx, dy);
      if (sp > 0 && dist > 0.5) {
        const step = Math.min(dist, sp * dt);
        this.vx = dx / dist * step / dt; this.vy = dy / dist * step / dt;
        this.ax += this.vx * dt; this.ay += this.vy * dt;
      } else { this.vx = 0; this.vy = 0; }
      // wheel towards the wanted facing; wide regiments wheel slower
      const w = U.clamp(this.maxSpeed * 0.9 / Math.max(30, this.halfW), 0.18, this.role === 'cavalry' ? 2.2 : 1.1);
      this.angle = U.turnTo(this.angle, this.goalAngle, w * dt);
      this.cos = Math.cos(this.angle); this.sin = Math.sin(this.angle);
      const C = TM.CONFIG;
      this.ax = U.clamp(this.ax, 10, C.WORLD_W - 10); this.ay = U.clamp(this.ay, 10, C.WORLD_H - 10);
    }

    setOrder(o) { if (this.order !== o) { this.order = o; this.orderT = 0; } }
    face(x, y) { this.goalAngle = Math.atan2(y - this.cy, x - this.cx); }
    go(x, y, speed) { this.goalX = x; this.goalY = y; this.speed = speed; }
    stop() { this.speed = 0; this.goalX = this.ax; this.goalY = this.ay; }
    // nearest standing member of this regiment to a point
    nearest(x, y) {
      let best = null, bd = Infinity;
      for (const u of this.members) {
        if (u.state !== ALIVE || u.fleeing) continue;
        const d = (u.x - x) * (u.x - x) + (u.y - y) * (u.y - y);
        if (d < bd) { bd = d; best = u; }
      }
      return best ? { u: best, d: Math.sqrt(bd) } : null;
    }
  }

  // ---------------------------------------------------------------- helpers
  const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  // distance between the front of R and the closest man of E
  function gapTo(R, E) {
    const nr = E.nearest(R.frontX(), R.frontY());
    return nr ? Math.max(0, nr.d - E.def.radius - R.def.radius) : Infinity;
  }
  function closing(K, R) {
    // is regiment K moving towards R?
    const dx = R.cx - K.cx, dy = R.cy - K.cy, l = Math.hypot(dx, dy) || 1;
    return (K.vx * dx + K.vy * dy) / l > K.maxSpeed * 0.35 || (K.pTarget === R && (K.pOrder === 'charge' || K.pOrder === 'lance'));
  }

  // ---------------------------------------------------------------- army command
  function general(B, t) {
    const T = B.tac, G = T.gen[t], E = T.gen[1 - t];
    const mine = T.regs.filter((r) => r.team === t && r.active());
    const foes = T.regs.filter((r) => r.team !== t && r.active());
    let mx = 0, my = 0, mn = 0, ex = 0, ey = 0, en = 0;
    for (const r of mine) { mx += r.cx * r.n; my += r.cy * r.n; mn += r.n; }
    for (const r of foes) { ex += r.cx * r.n; ey += r.cy * r.n; en += r.n; }
    G.cx = mn ? mx / mn : G.cx; G.cy = mn ? my / mn : G.cy;
    if (mn && en) {
      const ax = ex / en - G.cx, ay = ey / en - G.cy, l = Math.hypot(ax, ay) || 1;
      G.axX = ax / l; G.axY = ay / l; G.ecx = ex / en; G.ecy = ey / en;
    }
    // common pace of the battle line: the slowest formed infantry regiment
    let pace = Infinity, fsum = 0, fn = 0;
    for (const r of mine) {
      if (r.role !== 'front' || r.discipline === 0) continue;
      pace = Math.min(pace, r.maxSpeed);
      fsum += (r.frontX() - G.cx) * G.axX + (r.frontY() - G.cy) * G.axY; fn++;
    }
    G.pace = Number.isFinite(pace) ? pace : 40;
    G.lineFront = fn ? fsum / fn : 0;
    // stance: an army much stronger at range holds its line and lets the enemy walk into the arrows
    const shoot = (s) => T.regs.reduce((a, r) => a + (r.team === s && r.active() && r.role === 'missile' ? r.n : 0), 0);
    const melee = (s) => T.regs.reduce((a, r) => a + (r.team === s && r.active() && r.role !== 'missile' ? r.n : 0), 0);
    const myS = shoot(t), enS = shoot(1 - t);
    const wantDefend = myS >= 20 && myS > 1.6 * enS && melee(1 - t) > 0;
    if (G.stance === 'defend') {
      // give up waiting if the enemy waits too (or nothing comes)
      G.standT += THINK;
      if (!wantDefend || (G.standT > 30 && !B.contact[1 - t])) G.stance = 'attack';
    } else if (wantDefend && !B.contact[t] && B.time < 5) { G.stance = 'defend'; G.standT = 0; }
    void E;
  }

  // ---------------------------------------------------------------- target choice
  function pickTarget(R, B, foes, scoreFn) {
    let best = null, bs = Infinity;
    for (const E of foes) {
      const s = scoreFn(E);
      if (s < bs) { bs = s; best = E; }
    }
    // stick to the current target unless the new one is clearly better
    if (R.target && foes.includes(R.target) && best !== R.target) {
      const cur = scoreFn(R.target);
      if (cur < bs + 70) best = R.target;
    }
    return best;
  }

  function infantryScore(R, B, T) {
    const pref = R.def.prefer || {};
    return (E) => {
      const d = dist(R.cx, R.cy, E.cx, E.cy) - E.radius;
      const dx = E.cx - R.cx, dy = E.cy - R.cy, l = Math.hypot(dx, dy) || 1;
      const ahead = (dx * R.cos + dy * R.sin) / l;          // prefer what is in front of us
      let s = d + (1 - ahead) * 120;
      let crowd = 0;
      for (const F of T.regs) if (F !== R && F.team === R.team && F.pTarget === E && F.active() && F.role !== 'missile' && F.role !== 'cavalry') crowd++;
      s += crowd * 90;                                        // spread over the enemy line
      if (pref[E.type]) s -= pref[E.type] * 1.5;
      if (E.routing) s += 260;                                // infantry doesn't run after fugitives
      if (E.role === 'cavalry' && R.type !== 'spear') s += 120;
      if (R.doctrine === 'spearhead') s += dist(E.cx, E.cy, T.gen[R.team].ecx, T.gen[R.team].ecy) * 0.8; // drive into the centre
      return s;
    };
  }

  // ---------------------------------------------------------------- orders by role
  function thinkFront(R, B, G, foes) {
    const T = B.tac;
    // reserves follow their front regiment until it needs help
    if (R.role === 'support') {
      const F = R.supportOf;
      const needed = !F || !F.active() || F.strength < 0.6 || F.engagedT > 10 || (F.engaged > 0.2 && R.orderT > 25);
      if (!needed) {
        R.setOrder('support');
        const ox = R.supOff.x, oy = R.supOff.y;
        R.go(F.ax + F.cos * ox - F.sin * oy, F.ay + F.sin * ox + F.cos * oy, R.maxSpeed);
        R.goalAngle = F.angle;
        return;
      }
      R.role = 'front';
      tacticalEvent(B, R, 'reserve', `${TM.TEAMS[R.team].name}: резерв (${R.name}) вступает в бой`);
    }
    const tgt = pickTarget(R, B, foes, infantryScore(R, B, T));
    R.target = tgt;
    if (!tgt) { R.setOrder('hold'); R.stop(); return; }
    const gap = gapTo(R, tgt);
    // pikes against cavalry: stop, turn and plant the spears
    if (R.type === 'spear' && R.engaged < 0.3) {
      let K = null, kd = 260;
      for (const E of foes) {
        if (E.role !== 'cavalry') continue;
        const d = gapTo(R, E);
        if (d < kd && closing(E, R)) { kd = d; K = E; }
      }
      if (K) {
        if (R.order !== 'brace') tacticalEvent(B, R, 'brace', `${TM.TEAMS[R.team].name}: ${R.name} выставили копья против конницы`);
        R.setOrder('brace'); R.stop(); R.face(K.cx, K.cy);
        return;
      }
    }
    const horde = R.discipline === 0, monster = R.role === 'monster';
    const chargeAt = horde ? 130 : monster ? 120 : 70;
    if (G.stance === 'defend' && gap > 170 && R.engaged < 0.1 && !horde) {
      R.setOrder('hold'); R.stop(); R.face(tgt.cx, tgt.cy);
      return;
    }
    R.face(tgt.cx, tgt.cy);
    if (gap > chargeAt && R.engaged < 0.1) {
      // keep the line straight: regiments ahead of the line wait, those behind catch up
      let sp = horde || monster ? R.maxSpeed : Math.min(R.maxSpeed, G.pace);
      if (!horde && !monster && R.role === 'front') {
        const myF = (R.frontX() - G.cx) * G.axX + (R.frontY() - G.cy) * G.axY;
        const ahead = myF - G.lineFront;
        if (ahead > 18) sp *= 0.45; else if (ahead < -18) sp = R.maxSpeed;
      }
      R.setOrder('advance');
      const nr = tgt.nearest(R.cx, R.cy);
      R.go(nr ? nr.u.x : tgt.cx, nr ? nr.u.y : tgt.cy, sp);
    } else if (R.engaged < 0.3 && R.orderT < 6) {
      R.setOrder('charge');
      R.go(tgt.cx, tgt.cy, R.maxSpeed);
    } else {
      // fighting: keep pressing slowly while the front is not fully in contact
      R.setOrder('engage');
      R.go(tgt.cx, tgt.cy, R.maxSpeed * (R.engaged > 0.5 ? 0.1 : 0.35));
    }
  }

  function thinkMissile(R, B, G, foes, friends) {
    const range = R.def.ranged.range;
    // threat: enemy foot (or fast horse) about to reach us — skirmish back a few steps, then shoot again
    let threat = null, td = Infinity;
    for (const E of foes) {
      if (E.role === 'missile' || E.routing) continue;
      const d = gapTo(R, E) - (E.role === 'cavalry' ? 70 : 0);
      if (d < td) { td = d; threat = E; }
    }
    const C = TM.CONFIG;
    const backing = R.order === 'fallback' && R.orderT < 2.2;
    if (threat && R.engaged < 0.35 && (td < 75 || (backing && td < 120))) {
      const ax = R.cx - threat.cx, ay = R.cy - threat.cy, al = Math.hypot(ax, ay) || 1;
      // away from the threat, leaning towards our own side of the field
      let dx = ax / al - G.axX * 0.6, dy = ay / al - G.axY * 0.6;
      const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      const gx = U.clamp(R.cx + dx * 130, 20, C.WORLD_W - 20), gy = U.clamp(R.cy + dy * 130, 20, C.WORLD_H - 20);
      if (dist(R.cx, R.cy, gx, gy) > 40) {   // nowhere to go (map edge): stand and shoot
        R.setOrder('fallback'); R.go(gx, gy, R.def.speed);
        R.goalAngle = Math.atan2(-ay, -ax);
        R.target = threat; R.aim = null;
        return;
      }
    }
    // choose what to shoot: an enemy coming at us > enemy archers > melee in progress (rear ranks)
    let best = null, bs = Infinity;
    for (const E of foes) {
      const d = gapTo(R, E);
      let s = d;
      if (d > range + 60) s += 400;
      if (E.engaged > 0.2) s += 160;
      if (E.role === 'missile') s -= 40;
      if (E.routing) s += 120;
      if (closing(E, R)) s -= 140;
      if (s < bs) { bs = s; best = E; }
    }
    R.target = best;
    if (!best) { R.setOrder('hold'); R.stop(); R.aim = null; return; }
    const nr = best.nearest(R.cx, R.cy);
    R.aim = nr ? nr.u : null;
    const d = gapTo(R, best);
    R.face(best.cx, best.cy);
    // never walk out in front of our own battle line
    const hasLine = friends.some((F) => (F.role === 'front' || F.role === 'support') && F.active());
    const myF = (R.frontX() - G.cx) * G.axX + (R.frontY() - G.cy) * G.axY;
    const tooFar = hasLine && myF > G.lineFront - 45;
    if (d > range - 25) {
      R.setOrder('advance');
      if (tooFar) R.stop(); else R.go(best.cx, best.cy, hasLine ? Math.min(R.maxSpeed, G.pace) : R.maxSpeed);
      return;
    }
    if (R.order !== 'shoot') tacticalEvent(B, R, 'volley', `${TM.TEAMS[R.team].name}: ${R.name} дают залп`);
    R.setOrder('shoot'); R.stop();
    R.volleyT -= THINK;
    if (R.volleyT <= 0) volley(R, B, best);
  }

  // A volley: every loaded archer looses within ~0.4 s at the target regiment. When it is fighting our
  // own men, aim at its rear ranks (the men farthest from us) to keep arrows out of the melee.
  function volley(R, B, E) {
    const tgts = [];
    for (const u of E.members) if (u.state === ALIVE) tgts.push(u);
    if (!tgts.length) return;
    const fx = R.frontX(), fy = R.frontY();
    if (E.engaged > 0.15) {
      tgts.sort((a, b) => dist(fx, fy, b.x, b.y) - dist(fx, fy, a.x, a.y) || a.id - b.id);
      tgts.length = Math.max(1, Math.ceil(tgts.length * 0.5));
    }
    let fired = 0;
    for (const u of R.members) {
      if (u.state !== ALIVE || u.fleeing || u.rangedCd > 0.5 || B.time - u.contactT < 0.6) continue;
      u.volleyAt = B.time + U.rand() * 0.4;
      u.volleyTarget = tgts[(U.rand() * tgts.length) | 0];
      fired++;
    }
    R.volleyT = fired ? R.def.ranged.cooldown : 0.2;
  }

  function cavalryScore(R, B) {
    const base = { archer: 3.2, knight: 1.6, sword: 1, spear: 0.35, giant: 0.15 };
    return (E) => {
      let v = base[E.type] || 1;
      if (E.engaged > 0.2) v *= 2.2;                        // hit them while they are busy
      if (E.routing) v *= 1.8;                              // ride down the fugitives
      if (E.type === 'spear' && E.engaged < 0.25) v *= 0.25; // never into an unengaged pike wall
      v *= E.n / (E.n + 8);
      const d = dist(R.cx, R.cy, E.cx, E.cy);
      return -v / (1 + d / 450);
    };
  }

  // the first enemy foot regiment standing across the straight path from R to E (if any)
  function blocker(R, E, foes) {
    const ax = R.cx, ay = R.cy, bx = E.cx, by = E.cy, l2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay) || 1;
    let best = null, bt = 2;
    for (const F of foes) {
      if (F === E || !F.active() || F.role === 'missile' || F.role === 'cavalry') continue;
      const t = U.clamp(((F.cx - ax) * (bx - ax) + (F.cy - ay) * (by - ay)) / l2, 0, 1);
      if (t <= 0 || t >= 1) continue;
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      if (dist(px, py, F.cx, F.cy) < F.radius + 34 && t < bt) { bt = t; best = F; }
    }
    return best;
  }

  // a point beyond the end of the enemy line on our side, level with the target: the way round
  function flankRoute(R, G, E, foes) {
    const px = -G.axY, py = G.axX;
    let lo = Infinity, hi = -Infinity;
    for (const F of foes) {
      if (!F.active() || F.role === 'cavalry') continue;
      const lat = (F.cx - G.cx) * px + (F.cy - G.cy) * py;
      lo = Math.min(lo, lat - F.halfW); hi = Math.max(hi, lat + F.halfW);
    }
    const my = (R.cx - G.cx) * px + (R.cy - G.cy) * py;
    const side = my >= (lo + hi) / 2 ? 1 : -1;
    const lat = side > 0 ? hi + 120 : lo - 120;
    const lon = (E.cx - G.cx) * G.axX + (E.cy - G.cy) * G.axY;
    const C = TM.CONFIG;
    return { x: U.clamp(G.cx + G.axX * lon + px * lat, 30, C.WORLD_W - 30), y: U.clamp(G.cy + G.axY * lon + py * lat, 30, C.WORLD_H - 30) };
  }

  function thinkCavalry(R, B, G, foes) {
    const T = B.tac;
    R.phaseT += THINK;
    // withdraw after the impact and the melee, then re-form for the next charge
    if (R.order === 'withdraw') {
      if (R.phaseT < 2.2 && dist(R.ax, R.ay, R.goalX, R.goalY) > 25) return;
      R.setOrder('reform'); R.phaseT = 0; R.stop();
      return;
    }
    if (R.order === 'reform' && R.phaseT < 1.4) return;
    if (R.order === 'lance' || R.order === 'melee') {
      const E = R.target;
      const done = !E || !E.active() || (R.order === 'lance' && R.phaseT > 3) || (R.order === 'melee' && R.phaseT > 2.6);
      if (R.order === 'lance' && E && E.active()) {
        // ride through the target, then fight it out briefly
        const passed = (R.ax - E.cx) * R.cos + (R.ay - E.cy) * R.sin > 0;
        if (passed || R.engaged > 0.4) { R.setOrder('melee'); R.phaseT = 0; R.stop(); }
      }
      if (!done) return;
      // break off: ride back towards our own side
      const bx = R.cx - (E ? E.cx - R.cx : G.axX * 100), by = R.cy - (E ? E.cy - R.cy : G.axY * 100), bl = Math.hypot(bx - R.cx, by - R.cy) || 1;
      R.setOrder('withdraw'); R.phaseT = 0;
      const gx = R.cx + (bx - R.cx) / bl * 200 - G.axX * 60, gy = R.cy + (by - R.cy) / bl * 200 - G.axY * 60;
      R.go(U.clamp(gx, 40, TM.CONFIG.WORLD_W - 40), U.clamp(gy, 40, TM.CONFIG.WORLD_H - 40), R.maxSpeed);
      R.goalAngle = Math.atan2(gy - R.cy, gx - R.cx);
      return;
    }
    // choose a target worth a charge
    const tgt = pickTarget(R, B, foes, cavalryScore(R, B));
    R.target = tgt;
    if (!tgt) { R.setOrder('hold'); R.stop(); return; }
    const d = gapTo(R, tgt);
    const wall = blocker(R, tgt, foes);
    const ourFight = T.regs.some((r) => r.team === R.team && r.role !== 'cavalry' && r.role !== 'missile' && r.engaged > 0.2);
    const theirHorse = foes.some((r) => r.role === 'cavalry' && r.active() && gapTo(R, r) < 320);
    // wait on the flank until a charge makes sense: enemy horse nearby, an open target, or the lines have clinched
    const worth = theirHorse || tgt.routing || ourFight || tgt.engaged > 0.2 || (!wall && tgt.role === 'missile') || B.time > 40;
    if (!worth) {
      R.setOrder('screen');
      const lx = G.cx + G.axX * (G.lineFront - 40), ly = G.cy + G.axY * (G.lineFront - 40);
      const px = -G.axY, py = G.axX, side = R.side || 1;
      const off = R.screenOff == null ? 0 : R.screenOff;
      R.go(lx + px * off * side, ly + py * off * side, Math.min(R.maxSpeed, G.pace));
      R.face(tgt.cx, tgt.cy);
      return;
    }
    // enemy foot in the way: ride round the end of their line
    if (wall && tgt.role !== 'cavalry' && d > 60) {
      const W = flankRoute(R, G, tgt, foes);
      if (R.order !== 'flank') tacticalEvent(B, R, 'flank', `${TM.TEAMS[R.team].name}: ${R.name} обходят фланг`);
      R.setOrder('flank');
      R.go(W.x, W.y, R.maxSpeed);
      R.goalAngle = Math.atan2(W.y - R.cy, W.x - R.cx);
      return;
    }
    // a formed regiment is hit from behind or the side, never head-on
    const ex = tgt.cx, ey = tgt.cy, efx = tgt.cos, efy = tgt.sin;
    const rx = R.cx - ex, ry = R.cy - ey;
    const inFront = rx * efx + ry * efy > tgt.front * 0.5;
    if (tgt.role !== 'missile' && tgt.role !== 'cavalry' && !tgt.routing && inFront && d > 70) {
      const side = (rx * -efy + ry * efx) >= 0 ? 1 : -1;
      const wx = ex - efy * side * (tgt.halfW + 110) - efx * 20, wy = ey + efx * side * (tgt.halfW + 110) - efy * 20;
      R.setOrder('flank');
      R.go(U.clamp(wx, 30, TM.CONFIG.WORLD_W - 30), U.clamp(wy, 30, TM.CONFIG.WORLD_H - 30), R.maxSpeed);
      R.goalAngle = Math.atan2(wy - R.cy, wx - R.cx);
      return;
    }
    if (d > 150) {
      R.setOrder('approach');
      const nr = tgt.nearest(R.cx, R.cy);
      R.go(nr ? nr.u.x : ex, nr ? nr.u.y : ey, R.maxSpeed * 0.8);
      R.face(ex, ey);
      return;
    }
    // the charge: full gallop through the target
    const dx = ex - R.cx, dy = ey - R.cy, l = Math.hypot(dx, dy) || 1;
    if (R.order !== 'lance' && (tgt.engaged > 0.2 || tgt.role === 'missile')) {
      const fromBehind = (dx * efx + dy * efy) / l > 0.3;
      if (fromBehind && tgt.role !== 'missile') tacticalEvent(B, R, 'rear', `${TM.TEAMS[R.team].name}: ${R.name} бьют в тыл (${tgt.name})!`);
    }
    R.setOrder('lance'); R.phaseT = 0;
    R.go(U.clamp(ex + dx / l * 70, 20, TM.CONFIG.WORLD_W - 20), U.clamp(ey + dy / l * 70, 20, TM.CONFIG.WORLD_H - 20), R.maxSpeed);
    R.goalAngle = Math.atan2(dy, dx);
  }

  // ---------------------------------------------------------------- rout & rally
  function thinkMorale(R, B) {
    // every tenth of the regiment lost shakes the survivors
    const lost = Math.floor((1 - R.strength) * 10);
    if (lost > (R.lostTenths || 0)) {
      const hit = (lost - (R.lostTenths || 0)) * 5;
      R.lostTenths = lost;
      if (B.opts.morale) for (const u of R.members) if (u.state === ALIVE && !u.def.fearless) u.morale -= hit;
    }
    if (!R.routing) {
      if (R.alive >= 3 && R.fleeing / R.alive >= 0.4) {
        R.routing = true;
        R.setOrder('rout'); R.stop(); R.target = null;
        if (R.alive >= 6) tacticalEvent(B, R, 'rout', `${TM.TEAMS[R.team].name}: ${R.name} бегут!`);
        // a regiment running past its neighbours shakes them
        for (const F of B.tac.regs) {
          if (F === R || F.team !== R.team || !F.active()) continue;
          if (dist(F.cx, F.cy, R.cx, R.cy) - F.radius - R.radius > 120) continue;
          for (const u of F.members) if (u.state === ALIVE && !u.def.fearless) u.morale -= 7;
        }
      }
      return false;
    }
    // rally: enough men have stopped running to re-form the regiment where they stand
    if (R.n >= 3 && R.n >= 0.4 * R.alive) {
      R.routing = false;
      R.ax = R.cx; R.ay = R.cy; R.compactCount = -1;
      R.setOrder('reform'); R.phaseT = 0; R.stop();
      if (R.n >= 5) tacticalEvent(B, R, 'rally', `${TM.TEAMS[R.team].name}: ${R.name} снова в строю`);
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- feed
  function tacticalEvent(B, R, key, text) {
    if (!text) return;
    const k = R.team + ':' + key;
    const last = B.tac.lastEvent[k] || -99;
    if (B.time - last < (key === 'rout' ? 2.5 : 8)) return;
    B.tac.lastEvent[k] = B.time;
    B.event(text, R.team);
  }

  // ---------------------------------------------------------------- build & update
  const TACTICS = {
    partition,

    // specs: [{team, type, angle, doctrine, members: [units]}]
    build(B, specs) {
      const T = B.tac = { regs: [], gen: [], tick: 0, lastEvent: {} };
      specs.forEach((s, i) => { if (s.members.length) T.regs.push(new Regiment(i, s.team, s.type, s.members, s.angle, s.doctrine)); });
      // processing order with the other army first (alternated every decision cycle)
      T.regsRev = T.regs.filter((r) => r.team === 1).concat(T.regs.filter((r) => r.team === 0));
      for (let t = 0; t < 2; t++) {
        T.gen.push({ stance: 'attack', standT: 0, pace: 40, lineFront: 0, cx: 0, cy: 0, ecx: 0, ecy: 0, axX: TM.TEAMS[t].dir, axY: 0 });
      }
      for (const R of T.regs) R.survey(B);
      for (let t = 0; t < 2; t++) general(B, t);
      // reserves: infantry standing right behind another friendly infantry regiment
      for (const R of T.regs) {
        if (R.role !== 'front' || R.discipline === 0) continue;
        let best = null, bd = Infinity;
        for (const F of T.regs) {
          if (F === R || F.team !== R.team || F.role !== 'front' || F.discipline === 0) continue;
          const dx = F.ax - R.ax, dy = F.ay - R.ay;
          const fwd = dx * R.cos + dy * R.sin, lat = -dx * R.sin + dy * R.cos;
          if (fwd > 8 && Math.abs(lat) < Math.max(F.halfW, R.halfW) * 0.8 && fwd < bd) { bd = fwd; best = F; }
        }
        if (best && best.role === 'front') {
          R.role = 'support'; R.supportOf = best;
          const dx = R.ax - best.ax, dy = R.ay - best.ay;
          R.supOff = { x: dx * best.cos + dy * best.sin, y: -dx * best.sin + dy * best.cos };
        }
      }
      // cavalry remembers its place on the flank
      for (const R of T.regs) {
        if (R.role !== 'cavalry') continue;
        const G = T.gen[R.team];
        const lat = (R.ax - G.cx) * -G.axY + (R.ay - G.cy) * G.axX;
        R.side = lat >= 0 ? 1 : -1; R.screenOff = Math.abs(lat);
      }
    },

    update(B, dt) {
      const T = B.tac;
      if (!T) return;
      T.acc = (T.acc || 0) + dt;
      if (T.acc >= THINK - 1e-9) {
        T.acc -= THINK;
        // decisions read each other's orders from the previous cycle (a snapshot), and the side that
        // decides first alternates: no army gets to react to the other's fresh orders
        for (const R of T.regs) { R.survey(B); R.compact(); R.pOrder = R.order; R.pTarget = R.target; }
        for (let t = 0; t < 2; t++) general(B, t);
        T.flip = !T.flip;
        const order = T.flip ? T.regs : T.regsRev;
        for (const R of order) {
          R.orderT += THINK;
          R.flankHits *= 0.6;
          if (R.alive === 0) { R.stop(); continue; }
          if (thinkMorale(R, B)) continue;
          if (R.n === 0) { R.stop(); continue; }
          if (R.order === 'reform') {
            R.phaseT += THINK;
            if (R.phaseT < 2.2 && R.lag > 8) { R.stop(); continue; }
            if (R.role === 'cavalry' && R.phaseT < 1.4) { R.stop(); continue; }
          }
          const G = T.gen[R.team];
          const foes = T.regs.filter((r) => r.team !== R.team && r.n > 0 && (r.active() || r.routing));
          const live = foes.filter((r) => r.active());
          const pool = live.length ? live : foes;
          if (R.role === 'missile') thinkMissile(R, B, G, pool, T.regs.filter((r) => r.team === R.team));
          else if (R.role === 'cavalry') thinkCavalry(R, B, G, foes.length ? foes : pool);
          else thinkFront(R, B, G, pool);
        }
      }
      for (const R of T.regs) R.move(dt);
    },

    // flank / rear blows against formed regiments (called from Battle.hit)
    blowFrom(v, nx, ny) {
      const R = v.reg;
      if (!R || R.discipline === 0 || R.routing) return 1;
      const c = R.cos * nx + R.sin * ny;  // > 0: the blow comes from behind the formation
      if (c > 0.4) { R.flankHits += 2; return 1.25; }
      if (c > -0.35) { R.flankHits += 1; return 1.1; }
      return 1;
    },

    leash(u) {
      const R = u.reg, o = R.order;
      if (R.role === 'monster') return o === 'engage' || o === 'charge' ? 110 : 34;
      if (R.role === 'cavalry') return o === 'melee' ? 75 : o === 'lance' ? 50 : 22;
      if (R.role === 'missile') return 6;
      const fight = o === 'engage' || o === 'charge';
      if (R.discipline === 0) return fight ? 90 : 30;
      if (fight) return u.rank === 0 ? 34 : u.rank === 1 ? 16 : 8;
      return u.rank === 0 ? 14 : 7;
    },

    NAME,
    // what each order looks like in the tactical overlay / tooltip
    ORDER_NAME: {
      hold: 'держат строй', advance: 'наступают', charge: 'в атаку', engage: 'сеча', brace: 'копья вперёд',
      support: 'резерв', shoot: 'залп', fallback: 'отходят', screen: 'прикрывают фланг', flank: 'обход',
      approach: 'сближение', lance: 'таран', melee: 'рубка', withdraw: 'отход', reform: 'строятся', rout: 'бегут',
    },
  };

  TM.Tactics = TACTICS;
})(window.TM = window.TM || {});
