#!/bin/sh
# Regenerate docs/propagating_wave.gif (the animation at the top of README.md):
# default parameters, "Stimulate Centre", time steps 0..44, kymograph shortened to 60 steps.
#
# Requires: Google Chrome (override the path with CHROME=...), python3 with Pillow.
# Takes ~2 minutes: Chrome is launched once per frame (parallel launches hang).
set -e
cd "$(dirname "$0")"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
STEPS=44            # last time step captured
KYMO_GIF=60         # kymograph height in steps for the GIF (150 in the app)
OUT=docs/propagating_wave.gif

[ -x "$CHROME" ] || { echo "Chrome not found at $CHROME (set CHROME=...)"; exit 1; }
python3 -c 'import PIL' 2>/dev/null || { echo "python3 with Pillow is required (pip install pillow)"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/frames" docs

# 1. Single-file page, modified so that it freezes after N steps (N from the URL hash)
./build.sh >/dev/null
python3 - "$TMP/h.html" "$KYMO_GIF" <<'EOF'
import sys
out, kymo = sys.argv[1], sys.argv[2]
s = open('dist/wave_simulator.html', encoding='utf-8').read()
for old, new in [
    ('const KYMO_STEPS = 150', f'const KYMO_STEPS = {kymo}'),
    ('window.onload = () => { init(); loop(); };',
     'window.onload = () => { init(); const n = +location.hash.slice(1); '
     'stimulate(Math.floor(NUM_CELLS / 2)); for (let k = 0; k < n; k++) step(); render(); };'),
]:
    if old not in s:
        raise SystemExit(f'make_gif.sh: could not find "{old}" in the built page — update this script')
    s = s.replace(old, new)
open(out, 'w', encoding='utf-8').write(s)
EOF

# 2. One screenshot per time step
n=0
while [ $n -le $STEPS ]; do
  printf '\rCapturing frame %d/%d' "$n" "$STEPS"
  "$CHROME" --headless=new --disable-gpu --force-device-scale-factor=1 --hide-scrollbars \
    --virtual-time-budget=800 --window-size=950,480 \
    --screenshot="$TMP/frames/f$(printf %03d $n).png" "file://$TMP/h.html#$n" >/dev/null 2>&1
  n=$((n + 1))
done
echo

# 3. Crop (title → bottom of kymograph), scale, shared palette, assemble looping GIF
python3 - "$TMP/frames" "$OUT" <<'EOF'
import sys, glob, os
from PIL import Image
frames_dir, out = sys.argv[1], sys.argv[2]
files = sorted(glob.glob(os.path.join(frames_dir, 'f*.png')))
frames = []
for f in files:
    im = Image.open(f).convert('RGB')
    if im.size != (950, 480):
        raise SystemExit(f'make_gif.sh: unexpected screenshot size {im.size} for {f}')
    frames.append(im.crop((25, 0, 925, 392)).resize((720, 314), Image.LANCZOS))
# Palette from all frames together, so colours (orange front, green status text) stay true
w, h = frames[0].size
montage = Image.new('RGB', (w, h * len(frames)))
for k, f in enumerate(frames):
    montage.paste(f, (0, k * h))
palette = montage.quantize(colors=128, method=Image.Quantize.MEDIANCUT)
q = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
durations = [700] + [80] * (len(q) - 2) + [1800]   # pause at start, 80 ms/step, hold the final V
q[0].save(out, save_all=True, append_images=q[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(f'Wrote {out}: {len(q)} frames, {os.path.getsize(out) // 1024} KB')
EOF
