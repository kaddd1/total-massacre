// Starting formations: converts an army composition into spawn positions.
// Local space: d = depth behind the front rank (>= 0), l = lateral offset.
(function (TM) {
  'use strict';
  const U = TM.U;

  const GAP = { sword: 4, spear: 4, berserk: 5, archer: 5, crossbow: 4, knight: 7, horsearcher: 8, giant: 14, general: 8 };
  const FOOT = ['giant', 'berserk', 'spear', 'sword', 'crossbow', 'archer'];   // front to back
  const HORSE = ['knight', 'horsearcher'];

  function spacing(key) {
    return TM.UNIT_TYPES[key].radius * 2 + GAP[key];
  }

  // Lays groups of units in ranks. widthFn(row) returns rank width in px.
  function ranks(order, counts, widthFn, out, startDepth, latOffset) {
    let depth = startDepth || 0;
    let row = 0;
    const lo = latOffset || 0;
    for (const key of order) {
      let n = counts[key] | 0;
      if (n <= 0) continue;
      const blk = out.blk = (out.blk || 0) + 1; // every block of one type becomes one or more regiments
      const D = spacing(key);
      while (n > 0) {
        const w = widthFn(row);
        const per = Math.max(1, Math.floor(w / D) + 1);
        const k = Math.min(per, n);
        const rowW = (k - 1) * D;
        const stagger = (row % 2) * D * 0.35;
        for (let i = 0; i < k; i++) {
          out.push({
            type: key, blk,
            d: depth + U.range(-1.2, 1.2),
            l: lo - rowW / 2 + i * D + stagger + U.range(-1.2, 1.2),
          });
        }
        n -= k;
        depth += D;
        row++;
      }
      depth += 6;
    }
    return depth;
  }

  function footCount(counts) {
    let n = 0;
    for (const k of FOOT) n += counts[k] | 0;
    return n;
  }

  // horse on the wings: knights next to the line, light horse farther out
  function flanks(counts, mainWidth, out) {
    let off = mainWidth / 2 + 46;
    for (const key of HORSE) {
      const nk = counts[key] | 0;
      if (!nk) continue;
      const D = spacing(key);
      const blockW = 3 * D;
      const left = Math.ceil(nk / 2), right = nk - left;
      off += blockW / 2;
      ranks([key], { [key]: left }, () => blockW, out, 0, -off);
      if (right) ranks([key], { [key]: right }, () => blockW, out, 0, off);
      off += blockW / 2 + 40;
    }
  }

  const LAYOUTS = {
    line(counts, out) {
      const main = footCount(counts);
      if (!main) return ranks(HORSE, counts, () => U.clamp(Math.sqrt((counts.knight | 0) + (counts.horsearcher | 0)) * 50, 60, 900), out);
      const W = U.clamp(Math.sqrt(main) * 42, 140, 1150);
      ranks(FOOT, counts, () => W, out);
      flanks(counts, W, out);
    },
    block(counts, out) {
      const main = footCount(counts);
      if (!main) return ranks(HORSE, counts, () => U.clamp(Math.sqrt((counts.knight | 0) + (counts.horsearcher | 0)) * 22, 40, 600), out);
      const W = U.clamp(Math.sqrt(main) * 16, 60, 720);
      ranks(FOOT, counts, () => W, out);
      flanks(counts, W, out);
    },
    wedge(counts, out) {
      ranks(['giant', 'knight', 'berserk', 'sword', 'spear', 'crossbow', 'archer', 'horsearcher'], counts, (row) => Math.min(1200, 10 + row * 30), out);
    },
    horde(counts, out) {
      let total = 0;
      for (const k of TM.UNIT_ORDER) total += counts[k] | 0;
      const R = Math.sqrt(total) * 13 + 30;
      for (const key of TM.UNIT_ORDER) {
        const n = counts[key] | 0;
        for (let i = 0; i < n; i++) {
          const a = U.rand() * Math.PI * 2;
          const rr = Math.sqrt(U.rand());
          let d = R * 0.75 + Math.cos(a) * rr * R * 0.75;
          if (key === 'archer' || key === 'crossbow') d += R * 0.35;
          if (key === 'giant' || key === 'knight' || key === 'horsearcher') d *= 0.6;
          out.push({ type: key, blk: 100 + TM.UNIT_ORDER.indexOf(key), d, l: Math.sin(a) * rr * R * 1.35 });
        }
      }
    },
  };

  // how an army's regiments behave, by formation
  const DOCTRINE = { line: 'line', block: 'line', wedge: 'spearhead', horde: 'horde' };

  TM.Formations = {
    spacing,
    DOCTRINE,
    // Spawn spots for an army: manual groups (editor) or one of the automatic formations.
    // Every spot carries its regiment: reg (index within the army), angle (regiment facing), doctrine.
    spawn(teamIdx, army) {
      if (army.formation === 'manual') {
        const out = [];
        (army.groups || []).forEach((g, gi) => {
          const first = out.length;
          TM.Groups.layout(g, out);
          for (let i = first; i < out.length; i++) {
            out[i].reg = gi; out[i].angle = g.angle || 0; out[i].doctrine = g.shape === 'crowd' ? 'horde' : 'line';
          }
        });
        return out;
      }
      const spots = this.generate(teamIdx, army.counts, army.formation);
      const angle = TM.TEAMS[teamIdx].dir > 0 ? 0 : Math.PI;
      const doctrine = DOCTRINE[army.formation] || 'line';
      const reg = TM.Tactics.partition(spots, angle, doctrine === 'horde');
      spots.forEach((s, i) => { s.reg = reg[i]; s.angle = angle; s.doctrine = doctrine; });
      return spots;
    },
    generate(teamIdx, counts, formation) {
      const C = TM.CONFIG;
      const dir = TM.TEAMS[teamIdx].dir;
      const local = [];
      (LAYOUTS[formation] || LAYOUTS.line)(counts, local);
      const frontX = C.WORLD_W / 2 - dir * C.ARMY_GAP;
      const cy = C.WORLD_H / 2;
      return local.map((p) => ({
        type: p.type, blk: p.blk,
        x: U.clamp(frontX - dir * p.d, 24, C.WORLD_W - 24),
        y: U.clamp(cy + p.l * dir, 24, C.WORLD_H - 24),
      }));
    },
  };
})(window.TM = window.TM || {});
