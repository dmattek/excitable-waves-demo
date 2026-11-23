// UI: rendering, controls and the live simulation loop. Model logic lives in model.js.
const KYMO_STEPS = 150, ROW_PX = 2;  // kymograph: 150 steps × 2 px

let params = {...DEFAULT_PARAMS};
let cells = [], kymograph = [], running = true, time = 0;
let pending = new Set();   // cells stimulated by the user, applied at the next step

const cellsEl = document.getElementById('cells');
const canvas = document.getElementById('kymograph');
const ctx = canvas.getContext('2d');
const timeDisplay = document.getElementById('time-display');
const boundaryDisplay = document.getElementById('boundary-display');
const regimeDisplay = document.getElementById('regime-display');

const KYMO_EMPTY = '#f1f5f9';

// ---------------------------------------------------------------------------
// Live simulation
// ---------------------------------------------------------------------------

function init() {
  cells = freshCells();
  kymograph = [];
  pending = new Set();
  time = 0;
  timeDisplay.textContent = time;
  cellsEl.innerHTML = '';
  for (let i = 0; i < NUM_CELLS; i++) {
    const div = document.createElement('div');
    div.className = 'cell';
    div.addEventListener('click', () => stimulate(i));
    cellsEl.appendChild(div);
  }
  canvas.width = canvas.offsetWidth;
  canvas.height = KYMO_STEPS * ROW_PX;
  updateRegimeDisplay();
  render();
}

// A stimulus excites a small block of cells centred on i (a single cell is sub-threshold
// for its neighbours whenever D·λ < θ). It is applied at the next time step.
function stimulate(i) {
  const half = Math.floor(STIM_WIDTH / 2);
  const start = Math.min(Math.max(0, i - half), NUM_CELLS - STIM_WIDTH);
  for (let k = start; k < start + STIM_WIDTH; k++) pending.add(k);
  if (!running) render();   // show queued stimulus while paused
}

function step() {
  cells = advance(cells, params, pending);
  pending = new Set();
  time++;
  timeDisplay.textContent = time;

  kymograph.push(cells.map(getColor));
  if (kymograph.length > KYMO_STEPS) kymograph.shift();
}

// The boundary does not depend on τ_ref, so it is cached and only recomputed when another parameter changes.
let boundaryCache = {key: null, value: null};

function updateRegimeDisplay() {
  const {refractory, ...rest} = params;
  const key = JSON.stringify(rest);
  if (boundaryCache.key !== key) boundaryCache = {key, value: reexcitationBoundary(params)};
  const k = boundaryCache.value;
  boundaryDisplay.innerHTML =
    k < 0        ? 'No re-excitation at any τ<sub>ref</sub>' :
    k >= REF_MAX ? `Re-excitation at all τ<sub>ref</sub> ≤ ${REF_MAX}` :
                   `Re-excitation if τ<sub>ref</sub> ≤ ${k} (now ${refractory})`;

  const r = probeRegime(params);
  let text, className;
  if (r.regime === 'refire') {
    text = '⚠ Re-excitation: messenger outlasts refractoriness → repeated waves';
    className = 'warning';
  } else if (r.regime === 'localRefire') {
    text = '⚠ Local re-firing: stimulated cells fire again briefly, but no wave spreads';
    className = 'warning';
  } else if (r.regime === 'noInit') {
    text = `✗ Stimulus too weak to start a wave — a running wave still propagates (v ≈ ${r.speed.toFixed(1)})`;
    className = 'fail';
  } else if (r.regime === 'noProp') {
    text = '✗ No propagation: even a running wave dies out';
    className = 'fail';
  } else {
    text = `✓ Single stable wave, v ≈ ${r.speed.toFixed(1)} cells/step`;
    className = 'stable';
  }
  regimeDisplay.innerHTML = `<span class="${className}">${text}</span>`;
}

function getColor(c) {
  if (c.state === 'active') return '#f59e0b';
  if (c.state === 'refractory') {
    // Red (#fca5a5) → excitable blue (#dbeafe) as recovery progresses
    const recovery = Math.min(1, Math.max(0, 1 - c.timer / Math.max(1, params.refractory)));
    const r = Math.round(252 + recovery * (219 - 252));
    const g = Math.round(165 + recovery * (234 - 165));
    const b = Math.round(165 + recovery * (254 - 165));
    return `rgb(${r},${g},${b})`;
  }
  return '#dbeafe';
}

function drawKymograph() {
  const w = canvas.width, cellWidth = w / NUM_CELLS;
  ctx.fillStyle = KYMO_EMPTY;
  ctx.fillRect(0, 0, w, canvas.height);
  // Newest row at the top: time runs upward
  for (let r = 0; r < kymograph.length; r++) {
    const row = kymograph[kymograph.length - 1 - r];
    for (let i = 0; i < NUM_CELLS; i++) {
      ctx.fillStyle = row[i];
      ctx.fillRect(i * cellWidth, r * ROW_PX, cellWidth + 1, ROW_PX);
    }
  }
}

function render() {
  const cellDivs = cellsEl.children;
  for (let i = 0; i < NUM_CELLS; i++) {
    cellDivs[i].style.background = getColor(cells[i]);
    cellDivs[i].classList.toggle('pending', pending.has(i));
  }
  drawKymograph();
}

function loop() {
  if (running) { step(); render(); }
  setTimeout(loop, 50);
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function bindSlider(id, labelId, key, scale, digits) {
  document.getElementById(id).oninput = e => {
    params[key] = +e.target.value / scale;
    document.getElementById(labelId).textContent = params[key].toFixed(digits);
    // Debounced: the hidden test runs can take ~100 ms, so wait until the slider stops moving
    clearTimeout(regimeTimer);
    regimeTimer = setTimeout(updateRegimeDisplay, 120);
  };
}
let regimeTimer = null;
bindSlider('pulse-width', 'pw-val', 'pulseWidth', 1, 0);
bindSlider('refractory', 'rp-val', 'refractory', 1, 0);
bindSlider('signal-life', 'sl-val', 'signalLife', 1, 0);
bindSlider('coupling', 'cs-val', 'coupling', 100, 2);
bindSlider('threshold', 'th-val', 'threshold', 100, 2);
bindSlider('coupling-range', 'cr-val', 'couplingRange', 1, 0);
bindSlider('spatial-decay', 'sd-val', 'spatialDecay', 100, 2);

document.getElementById('btn-pause').onclick = e => {
  running = !running;
  e.target.textContent = running ? 'Pause' : 'Resume';
  e.target.classList.toggle('paused', !running);
};
document.getElementById('btn-reset').onclick = () => init();
document.getElementById('btn-left').onclick = () => stimulate(0);
document.getElementById('btn-center').onclick = () => stimulate(Math.floor(NUM_CELLS / 2));
document.getElementById('btn-right').onclick = () => stimulate(NUM_CELLS - 1);
document.getElementById('btn-both').onclick = () => { stimulate(0); stimulate(NUM_CELLS - 1); };

window.onload = () => { init(); loop(); };
window.onresize = () => { canvas.width = canvas.offsetWidth; drawKymograph(); };
