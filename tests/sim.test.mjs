// Headless simulation tests (Node only, no browser needed):  node tests/sim.test.mjs
//
// The game scripts are plain browser scripts that attach to a global `TM`; they are evaluated
// here in a tiny window shim. Visual/audio code is not loaded: effects are a no-op proxy, which
// is exactly how the simulation must behave (it never depends on rendering or sound).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['config', 'utils', 'spatial', 'formations', 'units', 'tactics', 'battle', 'editor'];

function loadTM() {
  const sandbox = { console, Math, performance: { now: () => 0 }, document: { getElementById: () => null } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f + '.js'), 'utf8'), sandbox, { filename: f + '.js' });
  return sandbox.TM;
}
const TM = loadTM();
const NOFX = new Proxy({}, { get: () => () => {} });

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail ? '  — ' + detail : '')); }
}
const counts = (o) => Object.assign({ sword: 0, spear: 0, archer: 0, knight: 0, giant: 0 }, o);
const auto = (o, f) => ({ counts: counts(o), formation: f || 'line' });
const manual = (groups) => ({ formation: 'manual', groups, counts: counts({}) });
const grp = (type, count, x, y, angle, shape) => ({ id: `g_${type}_${x}_${y}`, type, count, cols: 10, shape: shape || 'block', angle, x, y });

function battle(armies, seed, extra) {
  const B = new TM.Battle(Object.assign({ armies: JSON.parse(JSON.stringify(armies)), seed }, extra || {}), NOFX);
  B.start();
  return B;
}
function runFor(B, seconds, onStep) {
  for (let i = 0; i < seconds * 60 && B.state !== 'over'; i++) { B.step(1 / 60); if (onStep) onStep(B); }
  return B;
}
function fingerprint(B) {
  let h = 2166136261 >>> 0;
  const mix = (v) => { h ^= Math.round(v * 1000) | 0; h = Math.imul(h, 16777619) >>> 0; };
  for (const u of B.units) { mix(u.x); mix(u.y); mix(u.hp); mix(u.state); mix(u.kills); }
  return `${B.winner}|${B.stats.map((s) => `${s.dead}/${s.fled}/${s.alive}`).join(',')}|${h.toString(16)}`;
}

// ---------------------------------------------------------------- determinism
console.log('\n# Determinism');
for (const [i, p] of TM.PRESETS.entries()) {
  const a = fingerprint(runFor(battle([p.red, p.blue], 1000 + i), 20));
  const b = fingerprint(runFor(battle([p.red, p.blue], 1000 + i), 20));
  check(`same seed → same battle: ${p.name}`, a === b, `${a} vs ${b}`);
}
{
  const a = fingerprint(runFor(battle([TM.PRESETS[0].red, TM.PRESETS[0].blue], 1), 20));
  const b = fingerprint(runFor(battle([TM.PRESETS[0].red, TM.PRESETS[0].blue], 2), 20));
  check('different seeds → different battles', a !== b);
}

// ---------------------------------------------------------------- robustness / edge cases
console.log('\n# Edge cases (no exceptions, no NaN, every battle ends)');
const EDGE = [
  ['1 sword vs 1 sword', auto({ sword: 1 }), auto({ sword: 1 })],
  ['1 archer vs 1 archer', auto({ archer: 1 }), auto({ archer: 1 })],
  ['1 giant vs 1 giant', auto({ giant: 1 }), auto({ giant: 1 })],
  ['40 giants vs 40 giants', auto({ giant: 40 }), auto({ giant: 40 })],
  ['250 knights vs 250 knights', auto({ knight: 250 }), auto({ knight: 250 })],
  ['500 spears (horde) vs 1 giant', auto({ spear: 500 }, 'horde'), auto({ giant: 1 })],
  ['wedge vs block', auto({ sword: 100, knight: 30 }, 'wedge'), auto({ spear: 150 }, 'block')],
  ['manual: both armies in one corner', manual([grp('sword', 50, 60, 60, 0)]), manual([grp('sword', 50, 90, 90, Math.PI)])],
  ['manual: groups on the same point', manual([grp('sword', 30, 1200, 750, 0)]), manual([grp('sword', 30, 1200, 750, Math.PI)])],
  ['manual: off-map coordinates', manual([grp('archer', 40, -500, -500, 0)]), manual([grp('archer', 40, 5000, 5000, Math.PI)])],
  ['manual crowds vs auto', manual([grp('knight', 60, 100, 100, 0, 'crowd')]), auto({ sword: 80 })],
];
for (const [name, red, blue] of EDGE) {
  let err = null, nan = 0, B = null;
  try {
    B = battle([red, blue], 7);
    runFor(B, 600, (b) => { if ((b.time * 60 | 0) % 60 === 0) for (const u of b.units) if (!Number.isFinite(u.x + u.y + u.hp)) nan++; });
  } catch (e) { err = e; }
  check(`edge: ${name}`, !err && !nan && B && B.state === 'over', err ? err.message : nan ? `NaN x${nan}` : `state=${B && B.state} t=${B && B.time.toFixed(0)}`);
}
{
  const B = runFor(battle([auto({ sword: 100, archer: 100 }), auto({ sword: 100, archer: 100 })], 3, { morale: false, friendlyFire: false }), 600);
  check('options: morale off → nobody flees', B.stats[0].fled + B.stats[1].fled === 0 && B.state === 'over');
}

// ---------------------------------------------------------------- regressions
console.log('\n# Regressions');
{
  // Stray arrows still in the air must not kill the winners after the battle is decided.
  let bad = 0;
  for (let s = 1; s <= 12; s++) {
    const B = runFor(battle([auto({ archer: 1 }), auto({ archer: 1 })], s), 600);
    if (B.winner < 2 && B.stats[B.winner].alive === 0) bad++;
  }
  check('no post-victory deaths from arrows in flight (12 archer duels)', bad === 0, `${bad} duels ended "won with 0 survivors"`);
}
{
  // Routed units run to their own side even when the editor puts the armies anywhere.
  const exits = (red, blue) => {
    const B = battle([red, blue], 99), e = { L: 0, R: 0, T: 0, B: 0 };
    const seen = new Set();
    runFor(B, 150, (b) => { for (const u of b.units) if (u.team === 0 && u.state === TM.Units.ESCAPED && !seen.has(u)) { seen.add(u); if (u.x < 0) e.L++; else if (u.x > b.W) e.R++; else if (u.y < 0) e.T++; else e.B++; } });
    return e;
  };
  const v = exits(manual([grp('sword', 120, 1200, 250, Math.PI / 2), grp('archer', 60, 1200, 120, Math.PI / 2)]), manual([grp('sword', 200, 1200, 1200, -Math.PI / 2), grp('knight', 30, 1200, 1350, -Math.PI / 2)]));
  check('manual vertical layout: routed red (top army) escapes through the top edge', v.T > 0 && v.T >= v.B + v.L + v.R, JSON.stringify(v));
  // swapped sides: measure where routed red units actually run (mean x-velocity while fleeing)
  const B = battle([manual([grp('sword', 120, 1700, 750, Math.PI), grp('archer', 60, 1900, 750, Math.PI)]), manual([grp('sword', 200, 700, 750, 0), grp('knight', 30, 500, 750, 0)])], 99);
  let vx = 0, n = 0;
  runFor(B, 150, (b) => { for (const u of b.alive[0]) if (u.fleeing) { vx += u.vx; n++; } });
  check('manual swapped sides: routed red (right army) runs right, away from the enemy', n > 0 && vx / n > 5, `n=${n} mean vx=${(vx / Math.max(1, n)).toFixed(1)}`);
}
{
  // Visual/audio code must not consume the seeded simulation RNG: a battle with an "active"
  // sound stub (that records events) must match a silent one exactly.
  const silent = fingerprint(runFor(battle([TM.PRESETS[1].red, TM.PRESETS[1].blue], 42), 25));
  let events = 0;
  TM.Audio = { live: true, emit: () => { events++; } };
  const loud = fingerprint(runFor(battle([TM.PRESETS[1].red, TM.PRESETS[1].blue], 42), 25));
  delete TM.Audio;
  check('sound hooks do not influence the simulation', silent === loud && events > 100, `events=${events}`);
}

// ---------------------------------------------------------------- tactics
console.log('\n# Tactics (regiments, orders, morale)');
// watch a battle: orders seen per type, rank keeping before the first blow, volleys, friendly fire, routs
function watch(armies, seed, seconds) {
  const B = battle(armies, seed);
  const W = { B, orders: new Set(), lag: [], routed: new Set(), committed: 0, shots: new Map(), fired: 0, ff: 0, brace: 0, events: [] };
  let contact = false;
  const hit0 = B.hit.bind(B);
  B.hit = (a, v, dmg, kind, ...r) => {
    if (a && v.state === TM.Units.ALIVE) {
      if (a.team !== v.team && (kind === 'melee' || kind === 'charge')) contact = true;
      if (kind === 'arrow' && a.team === v.team) W.ff++;
      if (kind === 'brace') W.brace++;
    }
    return hit0(a, v, dmg, kind, ...r);
  };
  const fire0 = B.fireArrow.bind(B);
  B.fireArrow = (u, ...r) => { W.fired++; const l = W.shots.get(u.reg) || []; l.push(B.time); W.shots.set(u.reg, l); return fire0(u, ...r); };
  const ev0 = B.event.bind(B);
  B.event = (text, team) => { W.events.push(text); return ev0(text, team); };
  const support = B.tac.regs.filter((R) => R.role === 'support');
  runFor(B, seconds, (b) => {
    if ((b.time * 60 | 0) % 12) return;
    for (const R of b.tac.regs) {
      W.orders.add(R.type + ':' + R.order);
      if (R.routing) W.routed.add(R);
      if (!contact && R.n) W.lag.push(R.lag);
    }
  });
  W.committed = support.filter((R) => R.role === 'front').length;
  W.support = support.length;
  return W;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
{
  const P = TM.PRESETS[0];
  const B0 = battle([P.red, P.blue], 21);
  check('every soldier belongs to one regiment of his own team and type',
    B0.units.every((u) => u.reg && u.reg.team === u.team && u.reg.type === u.type && u.reg.members.includes(u)) &&
    B0.tac.regs.reduce((s, R) => s + R.members.length, 0) === B0.units.length);
  const W = watch([P.red, P.blue], 21, 300);
  check('ranks are kept on the march (mean distance from the own place < 6 px)', mean(W.lag) < 6, `mean ${mean(W.lag).toFixed(1)} px`);
  const cav = ['knight:screen', 'knight:flank', 'knight:lance', 'knight:withdraw', 'knight:reform'];
  check('cavalry covers the flank, rides round, charges, withdraws and re-forms', cav.every((o) => W.orders.has(o)), cav.filter((o) => !W.orders.has(o)).join(', ') + ' missing');
  // volleys: the shots of a regiment come in bursts (gaps > 0.6 s split the bursts)
  const bursts = [];
  for (const times of W.shots.values()) { let n = 1; for (let i = 1; i < times.length; i++) { if (times[i] - times[i - 1] > 0.6) { bursts.push(n); n = 0; } n++; } bursts.push(n); }
  check('archers shoot in volleys (mean volley ≥ 8 arrows)', mean(bursts) >= 8, `mean volley ${mean(bursts).toFixed(1)}`);
  check('archers do not shoot into the melee (friendly hits < 1% of arrows)', W.ff / W.fired < 0.01, `${W.ff}/${W.fired}`);
  check('reserves join the fight', W.support > 0 && W.committed > 0 && W.events.some((e) => e.includes('резерв')), `${W.committed}/${W.support} committed`);
  check('regiments break, the beaten army runs and the battle ends', W.routed.size > 0 && W.B.state === 'over' && W.B.winner < 2 && W.B.time < 200, `routed ${W.routed.size}, t=${W.B.time.toFixed(0)}`);
}
{
  // an army much stronger at range holds its ground and lets the enemy walk into the arrows
  const B = battle([auto({ spear: 60, archer: 200 }), auto({ sword: 200 })], 4);
  const x0 = mean(B.tac.regs.filter((R) => R.team === 0 && R.type === 'spear').map((R) => R.cx));
  runFor(B, 8);
  const x1 = mean(B.tac.regs.filter((R) => R.team === 0 && R.type === 'spear').map((R) => R.cx));
  check('the archer army stands on the defensive', B.tac.gen[0].stance === 'defend' && Math.abs(x1 - x0) < 25, `stance ${B.tac.gen[0].stance}, moved ${(x1 - x0).toFixed(0)} px`);
}
{
  // the arms counter each other
  let kn = 0, sp = 0, brace = 0, braceOrder = 0;
  for (let s = 1; s <= 4; s++) {
    if (runFor(battle([auto({ knight: 60 }), auto({ archer: 150 })], 40 + s), 300).winner === 0) kn++;
    const W = watch([auto({ knight: 60 }), auto({ spear: 150 })], 40 + s, 300);
    if (W.B.winner === 1) sp++;
    brace += W.brace; if (W.orders.has('spear:brace')) braceOrder++;
  }
  check('knights ride down unprotected archers (4/4)', kn === 4, `${kn}/4`);
  check('pikes beat knights (4/4), planting the spears against the charge', sp === 4 && braceOrder === 4 && brace > 0, `${sp}/4, brace order ${braceOrder}/4, brace hits ${brace}`);
}
{
  // mirror battles: no side wins much more often (the decision order alternates between the armies)
  const P = TM.PRESETS[0];
  let red = 0;
  for (let s = 1; s <= 12; s++) if (runFor(battle([P.red, P.blue], 500 + s), 300).winner === 0) red++;
  check('mirror battles are fair (red wins 3–9 of 12)', red >= 3 && red <= 9, `red won ${red}/12`);
}
{
  const a = fingerprint(runFor(battle([TM.PRESETS[1].red, TM.PRESETS[1].blue], 77), 90));
  const b = fingerprint(runFor(battle([TM.PRESETS[1].red, TM.PRESETS[1].blue], 77), 90));
  check('a long battle with all the tactics is deterministic', a === b, `${a} vs ${b}`);
}
{
  // ~2000 soldiers: the tactical layer must stay cheap
  const C = counts({ sword: 400, spear: 250, archer: 250, knight: 75, giant: 10 });
  const B = battle([{ counts: C, formation: 'line' }, { counts: C, formation: 'line' }], 3);
  const t0 = performance.now();
  runFor(B, 20);
  const ms = (performance.now() - t0) / (20 * 60);
  check(`~2000 soldiers simulate in < 10 ms per step (${ms.toFixed(2)} ms)`, ms < 10 && B.units.length > 1900);
}

// ---------------------------------------------------------------- editor geometry
console.log('\n# Editor groups');
{
  const g = grp('spear', 37, 1000, 600, 0.7);
  const spots = TM.Groups.layout(g, []);
  const cx = spots.reduce((s, p) => s + p.x, 0) / spots.length, cy = spots.reduce((s, p) => s + p.y, 0) / spots.length;
  check('layout: exact unit count', spots.length === 37);
  check('layout: centred on the group position', Math.hypot(cx - 1000, cy - 600) < 6, `centre ${cx.toFixed(1)},${cy.toFixed(1)}`);
  check('layout: deterministic (no RNG)', JSON.stringify(spots) === JSON.stringify(TM.Groups.layout(g, [])));
  const army = { formation: 'line', counts: counts({ sword: 70, spear: 50, archer: 50, knight: 14 }) };
  const groups = TM.Groups.fromAuto(0, army);
  const back = TM.Groups.counts({ formation: 'manual', groups });
  check('auto → manual conversion keeps the composition', back.sword === 70 && back.spear === 50 && back.archer === 50 && back.knight === 14, JSON.stringify(back));
  const bad = { groups: [{ type: 'dragon', count: 5 }, { type: 'sword', count: 99999, x: 'oops', y: null }] };
  TM.Groups.sanitize(bad);
  check('sanitize drops unknown types and clamps values', bad.groups.length === 1 && bad.groups[0].count === TM.UNIT_TYPES.sword.max && Number.isFinite(bad.groups[0].x));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
