// Excitable-medium model: pure functions, no DOM access.
// Loaded by index.html before app.js (browser globals) and by tests.js (Node, via module.exports).

const NUM_CELLS = 60, STIM_WIDTH = 3;

const DEFAULT_PARAMS = {
  pulseWidth: 1,      // τ_pulse: steps a cell stays active
  refractory: 4,      // τ_ref: steps a cell cannot be re-excited
  signalLife: 4,      // τ_sig: lifetime of the released messenger after the cell stops firing
  coupling: 0.30,     // D
  threshold: 0.18,    // θ
  couplingRange: 1,
  spatialDecay: 0.65  // λ
};

function freshCells() {
  return Array.from({length: NUM_CELLS}, () => ({state: 'excitable', timer: 0, signal: 0}));
}

// Each cell releases a messenger: level 1 while active, then decays with lifetime τ_sig.
// Input to cell i = Σ_{j≠i, |i-j|≤range} D·λ^|i-j|·signal_j
// All cells are updated synchronously from the previous state.
function advance(cellArray, p, stimulated) {
  const decay = p.signalLife > 0 ? Math.exp(-1 / p.signalLife) : 0;
  const weights = [];
  for (let d = 1; d <= p.couplingRange; d++) weights[d] = p.coupling * Math.pow(p.spatialDecay, d);

  return cellArray.map((c, i) => {
    let input = 0;
    const lo = Math.max(0, i - p.couplingRange), hi = Math.min(NUM_CELLS - 1, i + p.couplingRange);
    for (let j = lo; j <= hi; j++) {
      if (j !== i) input += cellArray[j].signal * weights[Math.abs(i - j)];
    }

    if (c.state === 'excitable') {
      if (input > p.threshold || (stimulated && stimulated.has(i))) {
        return {state: 'active', timer: p.pulseWidth, signal: 1};
      }
      return {state: 'excitable', timer: 0, signal: c.signal * decay};
    }
    if (c.state === 'active') {
      if (c.timer - 1 > 0) return {state: 'active', timer: c.timer - 1, signal: 1};
      if (p.refractory <= 0) return {state: 'excitable', timer: 0, signal: decay};
      return {state: 'refractory', timer: p.refractory, signal: decay};
    }
    // refractory
    const t = c.timer - 1;
    if (t <= 0) return {state: 'excitable', timer: 0, signal: c.signal * decay};
    return {state: 'refractory', timer: t, signal: c.signal * decay};
  });
}

// Run a hidden test wave from the left end (3-cell stimulus, as for a click).
// easyStart: launch the wave with a low threshold and switch to the real θ once it is running
// (cell max(10, range) has fired, so the front has a full coupling range of fired cells behind it)
// — this tests whether an established wave can propagate.
function probeWave(p, easyStart) {
  // Launch threshold: 0.15, or lower if even a single firing neighbour (D·λ) could not trigger a cell.
  const launchTh = Math.min(p.threshold, 0.15, 0.9 * p.coupling * p.spatialDecay);
  const startParams = easyStart ? {...p, threshold: launchTh} : p;
  let c = freshCells(), launched = !easyStart;
  let stim = new Set(Array.from({length: STIM_WIDTH}, (_, k) => k));
  const launchCell = Math.max(10, p.couplingRange);
  const fires = new Array(NUM_CELLS).fill(0), firstFire = new Array(NUM_CELLS).fill(-1);
  // With easyStart, cells near the start may re-fire only because of the low launch threshold;
  // count re-firing only well beyond the launch region.
  const refireFrom = easyStart ? 20 : 0;
  const hasRefired = () => fires.some((n, i) => i >= refireFrom && n > 1);
  for (let t = 0; t < 400; t++) {
    c = advance(c, launched ? p : startParams, stim);
    stim = null;
    c.forEach((cell, i) => {
      if (cell.state === 'active' && cell.timer === p.pulseWidth) {
        fires[i]++;
        if (firstFire[i] < 0) firstFire[i] = t;
      }
    });
    if (firstFire[launchCell] >= 0) launched = true;
    // After a re-firing, keep going until we know whether activity spreads to the far end
    // (repeated waves) or stays confined near the stimulus (local re-firing).
    if (hasRefired() && firstFire[NUM_CELLS - 1] >= 0) break;
    if (c.every(cell => cell.state === 'excitable' && cell.signal < 1e-3)) break;
  }
  const reachedEnd = firstFire[NUM_CELLS - 1] >= 0;
  const refire = hasRefired();
  const stillActive = c.some(cell => cell.state !== 'excitable');
  const a = 25, b = NUM_CELLS - 5;   // measure speed well after the launch phase
  const speed = reachedEnd && firstFire[b] > firstFire[a] ? (b - a) / (firstFire[b] - firstFire[a]) : null;
  return {reachedEnd, refire, stillActive, speed};
}

// Classify the current parameters:
//   'refire'    – cells fire more than once and waves spread (repeated waves)
//   'localRefire' – stimulated cells re-fire briefly, but no wave spreads (it always dies out;
//                  no sustained local oscillation was found over 1500 random parameter sets)
//   'stable'    – a click starts a single wave that crosses the array
//   'noInit'    – a click cannot start a wave, but an already running wave keeps going
//   'noProp'    – even a running wave dies out
function probeRegime(p) {
  const click = probeWave(p, false);
  if (click.refire) return {regime: click.reachedEnd ? 'refire' : 'localRefire'};
  if (click.reachedEnd) return {regime: 'stable', speed: click.speed};
  const running = probeWave(p, true);
  if (running.refire) return {regime: 'refire'};
  if (running.reachedEnd) return {regime: 'noInit', speed: running.speed};
  return {regime: 'noProp'};
}

// Largest τ_ref (0..REF_MAX) at which cells still re-excite, for the other current parameters.
// Re-excitation is monotone in τ_ref (checked over random parameter sets), so a binary search suffices.
// Returns -1 if no τ_ref re-excites, REF_MAX if all do.
const REF_MAX = 40;
function reexcitationBoundary(p) {
  const refires = tr => ['refire', 'localRefire'].includes(probeRegime({...p, refractory: tr}).regime);
  if (!refires(0)) return -1;
  if (refires(REF_MAX)) return REF_MAX;
  let lo = 0, hi = REF_MAX;          // refires(lo) && !refires(hi)
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (refires(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

if (typeof module !== 'undefined') {
  module.exports = {NUM_CELLS, STIM_WIDTH, REF_MAX, DEFAULT_PARAMS,
    freshCells, advance, probeWave, probeRegime, reexcitationBoundary};
}
