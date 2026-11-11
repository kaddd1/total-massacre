// End-to-end tests in real (headless) Chrome via the DevTools protocol: UI, editor, sound.
//   node tests/browser.test.mjs            (all sections)
//   node tests/browser.test.mjs ui audio   (selected sections: ui, editor, audio)
// Needs Google Chrome or Edge. Set CHROME_PATH if it is not found automatically.
// Uses the default autoplay policy on purpose: the sound tests check the "first gesture" flow.
import { openBrowser, check, results, sleep } from './lib/cdp.mjs';

// ------------------------------------------------------------------ UI
async function uiTests(b) {
  console.log('\n# UI');
  await b.open(); await b.ev('localStorage.clear()'); await b.open();
  check('game starts in setup mode with the default armies', await b.ev(`TM.Game.mode === 'setup' && TM.Game.battle.units.length === 368`));
  await b.ev(`[...document.querySelectorAll('#preset-list button')].find(x => x.textContent.includes('Мясорубка')).click()`); await sleep(300);
  check('preset updates the preview', (await b.ev('TM.Game.battle.units.length')) === 788);
  await b.ev(`(() => { const r = document.querySelector('#panel-0 input[type=range][data-k=giant]'); r.value = 10; r.dispatchEvent(new Event('input')); })()`); await sleep(300);
  check('slider changes the army', (await b.ev('TM.Game.battle.stats[0].byType.giant.deployed')) === 10);
  await b.ev(`document.querySelector('#form-1 button[data-f=wedge]').click()`); await sleep(200);
  check('formation button', (await b.ev('TM.Game.setup.armies[1].formation')) === 'wedge');
  check('setup persisted', (await b.ev(`JSON.parse(localStorage.getItem('total-massacre-setup-v1')).armies[0].counts.giant`)) === 10);
  await b.ev(`document.getElementById('btn-start').click()`); await sleep(1500);
  check('battle running with auto camera', await b.ev(`TM.Game.mode === 'battle' && TM.Game.battle.time > 0.5 && TM.Game.cam.auto`));
  await b.key('Digit3', '3');
  check('key 3 → speed 4x', (await b.ev('TM.Game.speed')) === 4);
  await b.key('BracketLeft', '['); await b.key('BracketLeft', '[');
  check('[ steps the speed down', (await b.ev('TM.Game.speed')) === 1);
  await b.key('Space', ' ');
  const t1 = await b.ev('TM.Game.battle.time'); await sleep(400);
  check('Space pauses', t1 === (await b.ev('TM.Game.battle.time')) && (await b.ev('TM.Game.paused')));
  await b.key('Space', ' '); await sleep(300);
  check('Space resumes', (await b.ev('TM.Game.battle.time')) > t1);
  const z0 = await b.ev('TM.Game.cam.zoom');
  await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 450, deltaX: 0, deltaY: -300 }); await sleep(200);
  check('wheel zooms and disables the auto camera', (await b.ev('TM.Game.cam.zoom')) > z0 && !(await b.ev('TM.Game.cam.auto')));
  for (let i = 0; i < 6; i++) { await b.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 450, deltaX: 0, deltaY: -120 }); await sleep(30); }
  check('close zoom snaps to whole pixels', await b.ev(`(() => { const c = TM.Game.cam, D = c.view() * c.dpr; return D >= 1 && Math.abs(D - Math.round(D)) < 1e-9; })()`));
  await b.key('Space', ' ');
  await b.ev(`(() => { const u = TM.Game.battle.alive[0][0]; TM.Game.cam.x = u.x; TM.Game.cam.y = u.y; })()`); await sleep(100);
  const u = await b.ev(`(() => { const u = TM.Game.battle.alive[0][0]; return { x: u.x, y: u.y - 4 }; })()`);
  const p = await b.scr(u.x, u.y);
  await b.mouse('mouseMoved', p.x, p.y); await sleep(150);
  check('hover shows the unit tooltip', await b.ev(`getComputedStyle(document.getElementById('tooltip')).display === 'block' && !!TM.Game.hover`));
  await b.mouse('mousePressed', p.x, p.y); await b.mouse('mouseReleased', p.x, p.y); await sleep(100);
  check('click follows the unit', await b.ev('!!TM.Game.cam.follow'));
  const cx = await b.ev('TM.Game.cam.x');
  await b.mouse('mousePressed', 700, 450); await b.mouse('mouseMoved', 760, 470, { buttons: 1 }); await b.mouse('mouseMoved', 860, 480, { buttons: 1 }); await b.mouse('mouseReleased', 860, 480); await sleep(100);
  check('drag pans the camera and stops following', (await b.ev('TM.Game.cam.x')) !== cx && !(await b.ev('TM.Game.cam.follow')));
  await b.key('KeyC', 'c');
  check('C toggles the auto camera', await b.ev('TM.Game.cam.auto'));
  await b.key('Space', ' ');
  await b.ev(`(() => { const B = TM.Game.battle; for (let i = 0; i < 60 * 400 && B.state !== 'over'; i++) B.step(1 / 60); })()`); await sleep(500);
  check('result screen after the battle', await b.ev(`!document.getElementById('result').classList.contains('hidden') && document.querySelector('.result-title').textContent.length > 5`));
  check('result: the winner has survivors', await b.ev(`(() => { const B = TM.Game.battle; return B.winner === 2 || B.stats[B.winner].alive > 0; })()`));
  await b.ev(`document.getElementById('res-view').click()`); await sleep(100);
  check('"view battlefield" closes the result', await b.ev(`document.getElementById('result').classList.contains('hidden')`));
  await b.key('KeyR', 'r'); await sleep(400);
  check('R restarts', await b.ev(`TM.Game.mode === 'battle' && TM.Game.battle.time < 2 && TM.Game.battle.state === 'running'`));
  await b.key('Escape', 'Escape'); await sleep(300);
  check('Esc returns to setup', await b.ev(`TM.Game.mode === 'setup' && document.getElementById('app').className === 'mode-setup'`));
  await b.ev(`[...document.querySelectorAll('#preset-list button')].find(x => x.classList.contains('rnd')).click()`); await sleep(300);
  check('random battle', await b.ev('TM.Game.battle.units.length > 0'));
  await b.ev(`document.querySelector('#panel-1 [data-act=clear]').click()`); await sleep(200);
  check('empty army disables the start button', await b.ev(`document.getElementById('btn-start').disabled`));
  await b.key('Enter', 'Enter'); await sleep(200);
  check('cannot start with an empty army', (await b.ev('TM.Game.mode')) === 'setup');
  await b.ev(`document.querySelector('#panel-1 [data-act=mirror]').click()`); await sleep(200);
  check('"same as enemy" copies the army', await b.ev(`JSON.stringify(TM.Game.setup.armies[0]) === JSON.stringify(TM.Game.setup.armies[1])`));
  await b.key('KeyH', 'h');
  check('H opens the help', await b.ev(`!document.getElementById('help').classList.contains('hidden')`));
  await b.key('Escape', 'Escape');
  check('Esc closes the help', await b.ev(`document.getElementById('help').classList.contains('hidden')`));
}

// ------------------------------------------------------------------ editor
async function editorTests(b) {
  console.log('\n# Editor');
  await b.open(); await b.ev('localStorage.clear()'); await b.open();
  const units = (t) => b.ev(`TM.Game.battle.stats[${t}].deployed`);
  const groups = (t) => b.ev(`TM.Game.setup.armies[${t}].groups.length`);
  await b.ev(`document.querySelector('#form-0 button[data-f=manual]').click()`); await sleep(300);
  const conv = await b.ev(`(() => { const a = TM.Game.setup.armies[0]; return { f: a.formation, n: a.groups.length, c: TM.Groups.counts(a), panel: document.getElementById('panel-0').classList.contains('is-manual') }; })()`);
  check('manual mode converts the auto layout into groups', conv.f === 'manual' && conv.n >= 4 && conv.panel, conv);
  check('conversion keeps the composition', conv.c.sword === 70 && conv.c.spear === 50 && conv.c.archer === 50 && conv.c.knight === 14, conv.c);
  await b.ev(`document.querySelector('#panel-0 [data-act=clear]').click()`); await sleep(300);
  check('clear empties the army', (await groups(0)) === 0 && (await units(0)) === 0);
  await b.ev(`document.querySelector('#ed-0 .ed-type[data-type=archer]').click()`);
  await b.ev(`(() => { const i = document.querySelector('#ed-0 input[type=number][data-f=count]'); i.value = 24; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.ev(`(() => { const i = document.querySelector('#ed-0 input[type=range][data-f=cols]'); i.value = 8; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await b.ev(`document.querySelector('#ed-0 [data-act=place]').click()`); await sleep(200);
  await b.ev('TM.Game.cam.zoom = 1; TM.Game.cam.x = 1200; TM.Game.cam.y = 750;'); await sleep(150);
  let p = await b.scr(900, 400);
  await b.click(p.x, p.y);
  const g0 = await b.ev('TM.Game.setup.armies[0].groups[0]');
  check('click places a group where clicked', (await units(0)) === 24 && Math.abs(g0.x - 900) < 3 && Math.abs(g0.y - 400) < 3 && g0.type === 'archer', g0);
  await b.ev(`document.querySelector('#ed-0 .ed-type[data-type=knight]').click()`);
  p = await b.scr(900, 700); await b.click(p.x, p.y);
  check('placing mode stays on for the next group', (await groups(0)) === 2 && (await b.ev('TM.Editor.armed')) === 0);
  await b.ev(`document.querySelector('#ed-0 [data-act=place]').click()`);
  p = await b.scr(900, 400); await b.click(p.x, p.y);
  check('click selects a group', (await b.ev('TM.Editor.sel && TM.Editor.sel.t')) === 0);
  const camX = await b.ev('TM.Game.cam.x'), to = await b.scr(1300, 300);
  await b.mouse('mouseMoved', p.x, p.y); await b.mouse('mousePressed', p.x, p.y);
  await b.mouse('mouseMoved', (p.x + to.x) / 2, (p.y + to.y) / 2, { buttons: 1 }); await b.mouse('mouseMoved', to.x, to.y, { buttons: 1 }); await b.mouse('mouseReleased', to.x, to.y); await sleep(250);
  const moved = await b.ev(`TM.Game.setup.armies[0].groups.find(g => g.type === 'archer')`);
  check('drag moves the group, not the camera', Math.abs(moved.x - 1300) < 6 && Math.abs(moved.y - 300) < 6 && (await b.ev('TM.Game.cam.x')) === camX, moved);
  await b.key('KeyE', 'e');
  check('E rotates the selected group by 15°', Math.abs((await b.ev(`TM.Game.setup.armies[0].groups.find(g => g.type === 'archer').angle`)) - Math.PI / 12) < 1e-6);
  await b.ev(`document.querySelector('#ed-0 [data-act=dup]').click()`); await sleep(150);
  check('duplicate', (await groups(0)) === 3);
  await b.key('Delete', 'Delete');
  check('Delete removes the selected group', (await groups(0)) === 2);
  const kn = await b.ev(`TM.Game.setup.armies[0].groups.find(g => g.type === 'knight')`);
  p = await b.scr(kn.x, kn.y); await b.click(p.x, p.y, 'right');
  check('right click removes the group under the cursor', (await groups(0)) === 1);
  await b.open();
  check('groups persist across reload', (await b.ev(`TM.Game.setup.armies[0].formation`)) === 'manual' && (await groups(0)) === 1);
  await b.ev(`(() => { const G = TM.Game, s = G.setup;
    s.armies[0].groups = [{ id: 'a1', type: 'sword', count: 60, cols: 12, shape: 'block', angle: Math.PI / 2, x: 1200, y: 300 }];
    s.armies[1] = { formation: 'manual', counts: s.armies[1].counts, groups: [{ id: 'b1', type: 'spear', count: 50, cols: 10, shape: 'crowd', angle: -Math.PI / 2, x: 1200, y: 1200 }] };
    TM.UI.syncFromSetup(); G.setupChanged(); })()`); await sleep(400);
  await b.ev(`document.getElementById('btn-start').click()`); await sleep(300);
  const y0 = await b.ev(`TM.Game.battle.alive[0].reduce((s, u) => s + u.y, 0) / TM.Game.battle.alive[0].length`);
  await b.ev(`(() => { const B = TM.Game.battle; for (let i = 0; i < 60 * 8; i++) B.step(1 / 60); })()`);
  const y1 = await b.ev(`TM.Game.battle.alive[0].reduce((s, u) => s + u.y, 0) / TM.Game.battle.alive[0].length`);
  check('a top army marches down towards the enemy', y1 > y0 + 60, { y0, y1 });
  await b.key('Escape', 'Escape'); await sleep(300);
  await b.ev(`document.querySelector('#form-0 button[data-f=line]').click()`); await sleep(300);
  check('switching back to an auto formation works', !(await b.ev(`document.getElementById('panel-0').classList.contains('is-manual')`)));
}

// ------------------------------------------------------------------ sound
async function audioTests(b) {
  console.log('\n# Sound');
  await b.open(); await b.ev('localStorage.clear()'); await b.open();
  check('no AudioContext before a user gesture (autoplay policy)', await b.ev('TM.Audio.ctx === null'));
  const ld = await b.ev(`TM.Audio.load().then(() => ({ ready: TM.Audio.ready, pools: Object.keys(TM.Audio.pools).length, n: Object.values(TM.Audio.pools).reduce((s, a) => s + a.length, 0), beds: Object.keys(TM.Audio.beds).length, ms: TM.Audio.loadMs }))`);
  check('all recorded sounds decode without a gesture', ld.ready && ld.pools >= 20 && ld.n >= 150 && ld.beds >= 9, ld);
  const total = await b.ev('TM.SOUND_BANK.sounds.length');
  check('every sound in the bundle decoded', ld.n + ld.beds - 1 === total, { decoded: ld.n + ld.beds - 1, bundle: total });
  const s = await b.rect('#btn-start'); await b.click(s.x, s.y); await sleep(1200);
  check('first click creates and runs the AudioContext', (await b.ev('TM.Audio.ctx && TM.Audio.ctx.state')) === 'running');
  check('start horns and war cries play', await b.ev(`TM.Audio.stats.byType.horn === 2 && TM.Audio.stats.byType.warcry >= 4`));
  await b.ev(`(() => { window.__an = TM.Audio.ctx.createAnalyser(); __an.fftSize = 2048; TM.Audio.limiter.connect(__an); window.__pk = 0; setInterval(() => { const d = new Float32Array(2048); __an.getFloatTimeDomainData(d); for (const v of d) __pk = Math.max(__pk, Math.abs(v)); }, 40); TM.Game.setSpeed(2); })()`);
  await sleep(8000);
  const live = await b.ev(`({ started: TM.Audio.stats.started, max: TM.Audio.stats.maxActive, ms: TM.Audio.stats.frameMs, peak: __pk, act: TM.Audio.act, beds: Object.values(TM.Audio.bedNodes).filter(n => n && n.level > 0.05).length })`);
  check('battle produces sound (voices + beds)', live.started > 30 && live.beds >= 2, live);
  check('voice cap respected', live.max <= 36, live.max);
  check('output is audible and not clipping (0.02 < peak < 1)', live.peak > 0.02 && live.peak < 1, live.peak);
  check('sound engine costs < 0.4 ms per frame', live.ms < 0.4, live.ms);
  await b.key('KeyM', 'm'); await sleep(500);
  const m1 = await b.ev('TM.Audio.stats.started'); await sleep(1200);
  const m2 = await b.ev(`({ s: TM.Audio.stats.started, st: TM.Audio.ctx.state, icon: document.getElementById('btn-snd').textContent })`);
  check('M mutes: no new sounds, context suspended', m2.s === m1 && m2.st === 'suspended' && m2.icon === '🔇', m2);
  await b.key('KeyM', 'm'); await sleep(600);
  check('M unmutes', (await b.ev('TM.Audio.ctx.state')) === 'running' && !(await b.ev('TM.Audio.muted')));
  await b.ev(`(() => { const v = document.getElementById('snd-vol'); v.value = 30; v.dispatchEvent(new Event('input', { bubbles: true })); })()`); await sleep(250);
  check('volume slider sets a perceptual master gain', Math.abs((await b.ev('TM.Audio.master.gain.value')) - 0.09) < 0.02);
  const sb = await b.rect('#btn-snd'); await b.click(sb.x, sb.y);
  await b.open();
  check('mute + volume persist across reload', await b.ev('TM.Audio.muted === true && TM.Audio.volume === 0.3'));
  check('no AudioContext is created while muted', await b.ev('TM.Audio.ctx === null'));
  await b.click(sb.x, sb.y); await sleep(300);
  await b.ev('TM.Game.start()'); await sleep(2000);
  await b.key('Space', ' '); await sleep(700);
  const p1 = await b.ev('TM.Audio.stats.started'); await sleep(1200);
  check('pause: no new battle sounds', p1 === (await b.ev('TM.Audio.stats.started')) && !(await b.ev('TM.Audio.live')));
  await b.key('Space', ' ');
  for (let i = 0; i < 5; i++) { await b.key('KeyR', 'r'); await sleep(80); }
  await sleep(200);
  check('rapid restarts keep one set of start horns', (await b.ev(`TM.Audio.voices.filter(v => TM.Audio.pools.horn.includes(v.src.buffer)).length`)) <= 2);
}

// ------------------------------------------------------------------ run
const want = process.argv.slice(2);
const sections = [['ui', uiTests], ['editor', editorTests], ['audio', audioTests]].filter(([n]) => !want.length || want.includes(n));
const b = await openBrowser();
try {
  for (const [, fn] of sections) await fn(b);
} catch (e) {
  check('test run finished without crashing', false, e.message);
} finally {
  check('no JavaScript errors in the page', b.errors.length === 0, b.errors.slice(0, 5));
  b.close();
}
console.log(`\n${results.passed} passed, ${results.failed} failed`);
process.exitCode = results.failed ? 1 : 0;
