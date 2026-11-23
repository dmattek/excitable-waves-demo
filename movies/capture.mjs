// Render lecture movies from the built simulator via the Chrome DevTools Protocol.
// usage: node capture.mjs <built html> <outdir>
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [,, built, outDir] = process.argv;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9337, SCALE = 2;

// --- page copy: no live loop, plus helpers for scripted clicks / params / markers
let s = fs.readFileSync(built, 'utf8');
const rep = (a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a); s = s.replace(a, b); };
rep('window.onload = () => { init(); loop(); };', 'window.onload = () => { init(); window.READY = true; };');
rep('</body>', `<style>
  .subtitle { min-height: 1.3em; color:#0f172a; font-weight:600; font-size:1rem; }
  .cell-container { position: relative; }
  .click-mark { position:absolute; top:-6px; height:44px; border:3px solid #0f172a; border-radius:8px; pointer-events:none; }
  .click-mark .lbl { position:absolute; top:-26px; left:50%; transform:translateX(-50%); font-size:0.85rem; font-weight:700; color:#0f172a; white-space:nowrap; }
  .buttons, .experiments { display:none; }
  body > .section-label:first-of-type { visibility:hidden; }
</style>
<script>
let clicks = [];
function setParams(o) {
  const ids = {pulseWidth:['pulse-width','pw-val',1,0], refractory:['refractory','rp-val',1,0], signalLife:['signal-life','sl-val',1,0],
    coupling:['coupling','cs-val',100,2], threshold:['threshold','th-val',100,2], couplingRange:['coupling-range','cr-val',1,0], spatialDecay:['spatial-decay','sd-val',100,2]};
  for (const [k, v] of Object.entries(o)) {
    params[k] = v; const [id, lab, sc, dg] = ids[k];
    document.getElementById(id).value = Math.round(v * sc);
    document.getElementById(lab).textContent = v.toFixed(dg);
  }
  boundaryCache = {key: null, value: null};
  updateRegimeDisplay();
}
function clickAt(i, label) { stimulate(i); clicks.push({i, t: time, label}); }
function caption(t) { document.querySelector('.subtitle').innerHTML = t; }
const _drawKymo = drawKymograph;
drawKymograph = function () {
  _drawKymo();
  const cw = canvas.width / NUM_CELLS;
  for (const c of clicks) {
    const r = time - (c.t + 1); if (r < 0 || r >= KYMO_STEPS) continue;
    ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc((c.i + 0.5) * cw, (r + 0.5) * ROW_PX, cw * 1.6, 0, 2 * Math.PI); ctx.stroke();
  }
  // on-cell click marker, visible for 8 steps after the click
  document.querySelectorAll('.click-mark').forEach(e => e.remove());
  for (const c of clicks) {
    if (time - c.t > 8 || time < c.t) continue;
    const cont = document.getElementById('cells'), first = cont.children[c.i - 1], last = cont.children[c.i + 1];
    const m = document.createElement('div'); m.className = 'click-mark';
    m.style.left = (first.offsetLeft - 3) + 'px'; m.style.width = (last.offsetLeft + last.offsetWidth - first.offsetLeft + 6) + 'px';
    m.innerHTML = '<span class="lbl">' + (c.label || 'click') + '</span>';
    cont.appendChild(m);
  }
};
</script></body>`);
const page = path.resolve(outDir, 'movie_page.html');
fs.writeFileSync(page, s);

// --- movie scripts: per step, optional action before the step
const movies = {
  refractory_no_retrigger: {
    params: {refractory: 10, signalLife: 10},
    steps: 95,
    events: {
      0: `clickAt(1, 'click'); caption('τ<sub>ref</sub> = τ<sub>sig</sub> = 10: a single wave with a long refractory wake')`,
      20: `clickAt(17, 'click → refractory'); caption('Clicking inside the refractory wake: no response')`,
      32: `clickAt(27, 'click → refractory'); caption('Clicking inside the refractory wake: no response')`,
      44: `clickAt(20, 'click → recovered'); caption('After τ<sub>ref</sub> the cells have recovered: a click starts new waves')`,
    },
  },
  reexcitation: {
    params: {refractory: 2, signalLife: 4},
    steps: 150,
    events: {
      0: `clickAt(30, 'click'); caption('τ<sub>ref</sub> = 2 < τ<sub>sig</sub> = 4: cells recover while the messenger is still above threshold')`,
      40: `caption('One click → the stimulus site re-fires on its own and emits a train of waves')`,
    },
  },
};

// --- Chrome + CDP
const udd = fs.mkdtempSync(path.join(outDir, 'chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${udd}`, `--force-device-scale-factor=${SCALE}`, '--window-size=960,900', 'about:blank'], {stdio: 'ignore'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets;
for (let k = 0; k < 50; k++) {
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.some(t => t.type === 'page')) break; } catch {}
  await sleep(200);
}
const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const waiting = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.exceptionThrown') console.error('PAGE EXC', JSON.stringify(m.params.exceptionDetails.exception?.description)); if (m.method==='Page.frameNavigated') console.error('NAV', m.params.frame.url); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
const send = (method, params = {}) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
const evaluate = async expr => { const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true}); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {width: 960, height: 900, deviceScaleFactor: SCALE, mobile: false});
for (const [name, mv] of Object.entries(movies)) {
  await send('Page.navigate', {url: 'file://' + page});
  for (let k = 0; k < 50 && !(await evaluate('window.READY === true')); k++) await sleep(100);
  await evaluate(`setParams(${JSON.stringify(mv.params)})`);
  // crop: top of page down to the bottom of the slider panel
  const clipH = await evaluate(`Math.ceil(document.querySelector('.controls').getBoundingClientRect().bottom + 10)`);
  const dir = path.join(outDir, name); fs.mkdirSync(dir, {recursive: true});
  const shot = async n => {
    const r = await send('Page.captureScreenshot', {format: 'png', clip: {x: 0, y: 0, width: 960, height: clipH, scale: 1}});
    fs.writeFileSync(path.join(dir, `f${String(n).padStart(4, '0')}.png`), Buffer.from(r.result.data, 'base64'));
  };
  let n = 0;
  await evaluate('render()'); await shot(n++);
  for (let t = 0; t < mv.steps; t++) {
    if (mv.events[t]) await evaluate(mv.events[t]);
    await evaluate('step(); render();');
    await shot(n++);
  }
  console.log(name, n, 'frames, height', clipH);
}
ws.close(); chrome.kill();
