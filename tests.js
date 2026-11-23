// Tests for the excitable-medium model. Run with:  node --test tests.js
// No dependencies; uses Node's built-in test runner.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {NUM_CELLS, STIM_WIDTH, REF_MAX, DEFAULT_PARAMS,
  freshCells, advance, probeRegime, reexcitationBoundary} = require('./model.js');

const P = overrides => ({...DEFAULT_PARAMS, ...overrides});

// A "click" on cell i, exactly as stimulate() in app.js does it.
function clickBlock(i) {
  const start = Math.min(Math.max(0, i - Math.floor(STIM_WIDTH / 2)), NUM_CELLS - STIM_WIDTH);
  return Array.from({length: STIM_WIDTH}, (_, k) => start + k);
}

// Run the model from rest with an initial stimulus; record firing events and states.
function simulate(p, stimulus, steps = 300) {
  let cells = freshCells(), stim = new Set(stimulus);
  const fires = new Array(NUM_CELLS).fill(0), firstFire = new Array(NUM_CELLS).fill(-1);
  const history = [];
  for (let t = 0; t < steps; t++) {
    cells = advance(cells, p, stim);
    stim = null;
    cells.forEach((c, i) => {
      if (c.state === 'active' && c.timer === p.pulseWidth) {
        fires[i]++;
        if (firstFire[i] < 0) firstFire[i] = t;
      }
    });
    history.push(cells);
  }
  const quiet = cells.every(c => c.state === 'excitable');
  return {fires, firstFire, history, quiet};
}

// Deterministic pseudo-random numbers (mulberry32) so failures are reproducible.
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// Random parameter set within the slider ranges of index.html
function randomParams(r) {
  const int = (a, b) => a + Math.floor(r() * (b - a + 1));
  return {pulseWidth: int(1, 20), refractory: int(0, 40), signalLife: int(0, 20),
    coupling: int(15, 50) / 100, threshold: int(15, 50) / 100,
    couplingRange: int(1, 15), spatialDecay: int(30, 90) / 100};
}

// ---------------------------------------------------------------------------
// 1. Cell rules (advance)
// ---------------------------------------------------------------------------

test('1. stimulated and wave-triggered cells are active for τ_pulse and refractory for τ_ref steps', () => {
  const p = P({pulseWidth: 3, refractory: 5});
  const {history} = simulate(p, clickBlock(30), 60);
  for (const i of [30, 45]) {   // 30: stimulated; 45: reached by the wave
    const seq = history.map(cells => cells[i].state);
    const first = seq.indexOf('active');
    assert.ok(first >= 0, `cell ${i} never fired`);
    const expected = [...Array(3).fill('active'), ...Array(5).fill('refractory'), 'excitable'];
    assert.deepEqual(seq.slice(first, first + expected.length), expected, `cell ${i}`);
  }
});

test('2. messenger is 1 while active, then decays by e^(-1/τ_sig) per step; τ_sig = 0 clears it at once', () => {
  for (const signalLife of [0, 4]) {
    const p = P({pulseWidth: 2, signalLife, threshold: 0.5});   // θ high: nothing propagates
    const {history} = simulate(p, [30], 8);
    const sig = history.map(cells => cells[30].signal);
    const decay = signalLife > 0 ? Math.exp(-1 / signalLife) : 0;
    assert.equal(sig[0], 1);
    assert.equal(sig[1], 1);
    for (let k = 2; k < sig.length; k++) {
      assert.ok(Math.abs(sig[k] - Math.pow(decay, k - 1)) < 1e-12, `τ_sig=${signalLife}, step ${k}`);
    }
  }
});

test('3. threshold: a single neighbour (range 1) fires its neighbour iff D·λ > θ (strictly)', () => {
  const fired = threshold => {
    const p = P({threshold, couplingRange: 1});
    const {history} = simulate(p, [30], 2);
    return history[1][31].state === 'active';
  };
  const Dlambda = DEFAULT_PARAMS.coupling * Math.pow(DEFAULT_PARAMS.spatialDecay, 1);   // 0.195
  assert.equal(fired(0.18), true);
  assert.equal(fired(0.20), false);
  assert.equal(fired(Dlambda), false, 'input exactly at threshold must not fire');
});

test('4. refractory cells never fire, whatever their input', () => {
  const p = P({coupling: 0.5, threshold: 0.15, couplingRange: 15, spatialDecay: 0.9});
  const cells = freshCells().map(() => ({state: 'active', timer: 5, signal: 1}));
  cells[30] = {state: 'refractory', timer: 3, signal: 0};
  const next = advance(cells, p, new Set([30]));
  assert.equal(next[30].state, 'refractory');
  assert.equal(next[30].timer, 2);
});

test('5. update is synchronous: mirroring the array commutes with a step', () => {
  const r = rng(1);
  const states = ['excitable', 'active', 'refractory'];
  for (let k = 0; k < 50; k++) {
    const p = randomParams(r);
    const cells = Array.from({length: NUM_CELLS}, () => {
      const state = states[Math.floor(r() * 3)];
      return {state, timer: state === 'excitable' ? 0 : 1 + Math.floor(r() * 5), signal: state === 'active' ? 1 : r()};
    });
    const mirror = a => [...a].reverse();
    assert.deepEqual(advance(mirror(cells), p), mirror(advance(cells, p)), `param set ${k}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Teaching claims (numbers quoted in the experiments section of index.html)
// ---------------------------------------------------------------------------

test('6. defaults: "Stimulate Centre" gives two waves at 1 cell/step, every cell fires once, then rest', () => {
  const {fires, firstFire, quiet} = simulate(DEFAULT_PARAMS, clickBlock(30));
  assert.deepEqual(fires, new Array(NUM_CELLS).fill(1));
  firstFire.forEach((t, i) => assert.equal(t, Math.max(0, Math.abs(i - 30) - 1), `cell ${i}`));
  assert.ok(quiet);
});

test('7. defaults: "Both Ends" waves annihilate (every cell fires exactly once)', () => {
  const {fires, quiet} = simulate(DEFAULT_PARAMS, [...clickBlock(0), ...clickBlock(NUM_CELLS - 1)]);
  assert.deepEqual(fires, new Array(NUM_CELLS).fill(1));
  assert.ok(quiet);
});

test('8. regimes quoted in the experiments text (index.html and README.md)', () => {
  const longRange = {couplingRange: 8, pulseWidth: 8, refractory: 15};
  const cases = [
    [{}, 'stable', 1],
    [{refractory: 2}, 'refire'],
    [{refractory: 0}, 'refire'],
    [{signalLife: 8, refractory: 5}, 'refire'],
    [{signalLife: 8, refractory: 6}, 'stable', 1],
    [{refractory: 3}, 'stable', 1],
    [{signalLife: 8, refractory: 4}, 'refire'],
    [{threshold: 0.20}, 'noProp'],
    [{coupling: 0.28}, 'stable', 1],
    [{coupling: 0.27}, 'noProp'],
    [{coupling: 0.25}, 'noProp'],
    [{coupling: 0.25, threshold: 0.17}, 'noProp'],
    [{coupling: 0.25, threshold: 0.16}, 'stable', 1],
    [{...longRange, threshold: 0.30}, 'stable', 2],
    [{...longRange, threshold: 0.45}, 'noInit'],
  ];
  for (const [overrides, regime, speed] of cases) {
    const r = probeRegime(P(overrides));
    assert.equal(r.regime, regime, JSON.stringify(overrides));
    if (speed !== undefined) assert.equal(r.speed, speed, JSON.stringify(overrides));
  }
});

test('8b. README: with τ_ref ≤ 2 the stimulus site becomes a pacemaker with period τ_pulse + τ_ref + 1', () => {
  for (const refractory of [0, 1, 2]) {
    const p = P({refractory});
    const {history} = simulate(p, clickBlock(30), 200);
    const fireTimes = history.map((cells, t) => cells[30].state === 'active' && cells[30].timer === p.pulseWidth ? t : -1)
      .filter(t => t >= 0);
    assert.ok(fireTimes.length > 10, `τ_ref=${refractory}: no sustained pacemaker`);
    const gaps = new Set(fireTimes.slice(1).map((t, k) => t - fireTimes[k]));
    assert.deepEqual([...gaps], [p.pulseWidth + refractory + 1], `τ_ref=${refractory}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Status-bar logic
// ---------------------------------------------------------------------------

test('9+10. re-excitation is monotone in τ_ref, and the binary search equals a full scan', () => {
  const r = rng(42);
  for (let k = 0; k < 25; k++) {
    const p = randomParams(r);
    const refires = [];
    for (let tr = 0; tr <= REF_MAX; tr++) {
      refires.push(['refire', 'localRefire'].includes(probeRegime({...p, refractory: tr}).regime));
    }
    const firstOff = refires.indexOf(false);
    if (firstOff >= 0) {
      assert.ok(refires.slice(firstOff).every(x => !x), `not monotone for ${JSON.stringify(p)}`);
    }
    const expected = firstOff < 0 ? REF_MAX : firstOff - 1;
    assert.equal(reexcitationBoundary(p), expected, JSON.stringify(p));
  }
});

test('11. regression: the low launch threshold of the running-wave probe does not count as re-excitation', () => {
  assert.equal(probeRegime(P({threshold: 0.25, refractory: 3})).regime, 'noProp');
  assert.equal(reexcitationBoundary(P({threshold: 0.25})), 0);
});

// ---------------------------------------------------------------------------
// 4. Theory: re-excitation of a travelling wave (range 1, τ_pulse = 1)
// ---------------------------------------------------------------------------
// A cell recovers τ_ref+1 steps after firing; its neighbours fired one step before and after it,
// so its input is D·λ·δ^τ_ref·(1+δ²) with δ = e^(-1/τ_sig). Re-excitation iff that exceeds θ.
function formulaBoundary(p) {
  const d = p.signalLife > 0 ? Math.exp(-1 / p.signalLife) : 0;
  let k = -1;
  for (let tr = 0; tr <= REF_MAX; tr++) {
    if (p.coupling * p.spatialDecay * Math.pow(d, tr) * (1 + d * d) > p.threshold) k = tr;
  }
  return k;
}

test('12a. a travelling wave re-excites exactly when the formula says so', () => {
  // A single-cell stimulus at the edge (enough at defaults: D·λ = 0.195 > θ) launches a wave whose
  // cells all see the travelling-wave configuration; the edge cell itself is less excitable.
  for (const signalLife of [1, 2, 3, 4, 6, 8, 10, 15, 20]) {
    const p = P({signalLife});
    const k = formulaBoundary(p);
    for (const tr of [k, k + 1]) {
      if (tr < 0) continue;
      const {fires} = simulate({...p, refractory: tr}, [0]);
      const refired = fires.some(n => n > 1);
      assert.equal(refired, tr <= k, `τ_sig=${signalLife}, τ_ref=${tr}, formula boundary ${k}`);
    }
  }
});

test('12b. after a click, the measured boundary is the formula value or one above (stimulus site re-fires first)', () => {
  for (const signalLife of [1, 2, 3, 4, 6, 8, 10, 15, 20]) {
    const p = P({signalLife});
    const k = formulaBoundary(p), measured = reexcitationBoundary(p);
    assert.ok(measured === k || measured === k + 1, `τ_sig=${signalLife}: measured ${measured}, formula ${k}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Page consistency
// ---------------------------------------------------------------------------

test('13. index.html slider defaults match DEFAULT_PARAMS, and every element app.js uses exists', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const sliders = {'pulse-width': ['pulseWidth', 1], 'refractory': ['refractory', 1], 'signal-life': ['signalLife', 1],
    'coupling': ['coupling', 100], 'threshold': ['threshold', 100], 'coupling-range': ['couplingRange', 1],
    'spatial-decay': ['spatialDecay', 100]};
  for (const [id, [key, scale]] of Object.entries(sliders)) {
    const m = html.match(new RegExp(`id="${id}"[^>]*value="([\\d.]+)"`));
    assert.ok(m, `slider ${id} not found`);
    assert.ok(Math.abs(+m[1] / scale - DEFAULT_PARAMS[key]) < 1e-9, `slider ${id}=${m[1]} vs ${key}=${DEFAULT_PARAMS[key]}`);
  }
  for (const [, id] of app.matchAll(/getElementById\('([^']+)'\)/g)) {
    assert.ok(html.includes(`id="${id}"`), `index.html lacks id="${id}"`);
  }
});
