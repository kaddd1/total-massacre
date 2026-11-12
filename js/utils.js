// Small math / random helpers.
(function (TM) {
  'use strict';

  // Seeded PRNG (mulberry32) so a battle can be reproduced from its seed.
  let _s = 1;
  function seed(s) { _s = (s >>> 0) || 1; }
  function rand() {
    _s = (_s + 0x6D2B79F5) | 0;
    let t = _s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  TM.U = {
    seed,
    rand,
    range: (a, b) => a + (b - a) * rand(),
    gauss: () => (rand() + rand() + rand() - 1.5) * 0.8165, // ~N(0,1) cheap
    clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
    // shortest signed angle from a to b
    angDiff(a, b) {
      let d = b - a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return d;
    },
    turnTo(a, b, maxStep) {
      const d = TM.U.angDiff(a, b);
      if (d > maxStep) return a + maxStep;
      if (d < -maxStep) return a - maxStep;
      return b;
    },
    fmtTime(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    },
  };
})(window.TM = window.TM || {});
