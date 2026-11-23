# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a self-contained educational simulation demonstrating excitable wave propagation in biological systems (e.g., cardiac action potentials, neural waves). `./build.sh` generates a single-file copy for distribution, `dist/wave_simulator.html` (styles.css, model.js and app.js inlined into index.html). It is a build artifact: never edit it, and rebuild before handing it out. The live demo linked in README.md (https://macdobry.net/teaching/excitable-waves-demo/wave_simulator.html) is this file, uploaded by hand — after changes, rebuild and re-upload it.

## Architecture

### File Structure
- **index.html**: Page structure with interactive controls and visualization containers
- **styles.css**: Styling for responsive controls, cell visualization, and kymograph display
- **model.js**: The model — pure functions, no DOM (`DEFAULT_PARAMS`, `freshCells`, `advance`, `probeWave`, `probeRegime`, `reexcitationBoundary`). Browser globals via `<script>`, and `module.exports` for Node
- **app.js**: UI — live simulation loop, rendering, controls, status bar. Loaded after model.js
- **tests.js**: Unit tests for model.js (and slider/ID consistency with index.html)
- **build.sh**: Builds `dist/wave_simulator.html`
- **make_gif.sh**: Regenerates `docs/propagating_wave.gif` for README.md (headless Chrome screenshots of the built page frozen at steps 0–44 after "Stimulate Centre", kymograph shortened to 60 steps; Pillow assembles the GIF). Launches Chrome sequentially — parallel headless launches hang

### Core Simulation Components (model.js)

**State Model**: Each cell has a state, a timer and a messenger `signal`:
- `excitable`: Fires when its input exceeds θ (or when stimulated by the user)
- `active`: Firing for τ_pulse steps; signal = 1
- `refractory`: Cannot fire for τ_ref steps
- After a cell stops firing its signal decays as exp(-1/τ_sig) per step (τ_sig = 0 → instant, i.e. signal only while active)

**Key Parameters** (`DEFAULT_PARAMS` in model.js, copied into `params` in app.js): `pulseWidth` (τ_pulse), `refractory` (τ_ref), `signalLife` (τ_sig), `coupling` (D), `threshold` (θ), `couplingRange`, `spatialDecay` (λ).

**Model update** (`advance(cells, params, stimulated)`, a pure function):
- Input to cell i = Σ_{j≠i, |i-j|≤range} D·λ^|i-j|·signal_j
- Synchronous update; user stimuli are queued in `pending` and applied inside the next step, so stimulated cells behave exactly like wave-triggered ones
- A click stimulates `STIM_WIDTH` = 3 cells, so a wave can be started even when one active cell is sub-threshold for its neighbour (D·λ < θ, e.g. in the long-range experiment)

**Regime indicator** (`probeWave` / `probeRegime` / `updateRegimeDisplay`): on every parameter change hidden test waves are run from the left end — one started by a normal 3-cell click, and (if that fails) one launched at low θ and switched to the real θ once running (in that probe re-firing is only counted from cell 20 on, since the low launch threshold itself causes re-firing near the start). Outcomes: `stable` (with measured speed), `refire` (cells fire repeatedly and waves spread), `localRefire` (stimulated cells re-fire briefly but no wave spreads, e.g. θ = 0.25, τ_ref = 0; it always dies out — no sustained local oscillation exists in this model), `noInit` (a click cannot start a wave but a running wave propagates), `noProp` (even a running wave dies). The status bar also shows the re-excitation boundary for the current parameters ("Re-excitation if τ_ref ≤ k"), found by `reexcitationBoundary` with a binary search over τ_ref (re-excitation is monotone in τ_ref; verified on 300 random parameter sets). It is cached because it does not depend on τ_ref, and slider updates are debounced by 120 ms. The boundary is not τ_ref = τ_sig. For nearest-neighbour coupling and τ_pulse = 1, a cell in a *travelling* wave re-excites iff D·λ·δ^τ_ref·(1+δ²) > θ with δ = e^(−1/τ_sig), i.e. τ_ref < τ_sig·ln(D·λ·(1+δ²)/θ) ≈ 0.55·τ_sig at the defaults (exact; tests 12a). After a 3-cell click, re-firing always starts at the stimulus site, whose cells fired simultaneously, so the boundary shown in the status bar is the formula value or one above it (test 12b). Note that τ_pulse barely matters for stability — the earlier "τ_ref < τ_pulse → unstable" rule was wrong for this model.

### Visualization System

**Cell Array** (`#cells`): 60 flex cells spanning the full width so they align with the kymograph columns. Colors: blue (excitable), orange (active), pink → excitable-blue gradient (refractory). Queued stimuli are outlined while paused.

**Kymograph** (`#kymograph` canvas): the last `KYMO_STEPS` = 150 steps stored as color rows (same colors as the cell array, so the refractory wake is visible), drawn `ROW_PX` = 2 px per step, newest at the top (time runs upward). Fully redrawn from the buffer each frame and on resize.

## Running the Application

Simply open `index.html` in any modern web browser. No build process, dependencies, or server required.

## Tests

`node --test tests.js` (Node ≥ 18, no dependencies, < 1 s). Covers cell rules (timing, messenger decay, strict threshold, refractoriness, synchronous update via mirror symmetry), the teaching claims (wave speed, annihilation, every regime quoted in the experiments text), the status-bar logic (monotonicity, binary search vs. full scan, launch-artifact regression), the re-excitation formula, and slider defaults / element IDs vs. index.html. Random tests use a seeded PRNG, so failures are reproducible.

## Key Educational Experiments

Described in the experiments section of index.html (values checked by tests 8/8b in tests.js; README.md has a longer guided version):

Defaults: τ_pulse = 1, τ_ref = 4, τ_sig = 4, D = 0.30, θ = 0.18, range = 1, λ = 0.65 (nearest-neighbour trigger wave; D·λ = 0.195 must exceed θ).

1. **Trigger wave**: "Stimulate Centre" → two waves at 1 cell/step, each cell fires once
2. **Wave collision**: "Both Ends" → annihilation
3. **Role of refractory period**: τ_ref ≤ 2 → re-excitation/wave trains; with τ_sig = 8 already at τ_ref ≤ 5 (see Regime indicator for the formula and its caveat)
4. **Threshold for propagation**: θ ≥ 0.20 (> D·λ) or D ≤ 0.25 → no propagation
5. **Starting vs. sustaining** (range 8, τ_pulse 8, τ_ref 15): v = 2–3 cells/step; at θ ≥ 0.42 a click cannot start a wave, but a wave started at θ = 0.30 survives raising θ to 0.50

## Modification Guidelines

When modifying the simulation:
- Keep all model logic in model.js, with `advance()` pure and synchronous, so the live simulation, `probeRegime` and the tests stay identical; keep DOM code out of model.js
- Simulation loop runs at 50ms intervals in the `loop()` function (app.js)
- If you change parameter defaults or model rules, run `node --test tests.js`; tests 8/8b hold the numbers quoted in the experiments text of index.html and README.md — update the texts and the tests together
- Change defaults in `DEFAULT_PARAMS` *and* the slider `value` attributes in index.html (test 13 checks they match)
- Run `./build.sh` before distributing
- After visible UI or default-parameter changes, run `./make_gif.sh` so the README animation matches
