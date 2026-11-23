import sys, glob, os, subprocess
d, out, holds = sys.argv[1], sys.argv[2], eval(sys.argv[3])   # holds: {frame: seconds}
fs = sorted(glob.glob(f'{d}/f*.png')); dt = 0.1
with open(f'{d}/list.txt', 'w') as f:
    for k, p in enumerate(fs):
        f.write(f"file '{os.path.abspath(p)}'\nduration {holds.get(k, dt) if k < len(fs)-1 else 2.5}\n")
    f.write(f"file '{os.path.abspath(fs[-1])}'\n")
subprocess.run(['ffmpeg','-y','-loglevel','error','-f','concat','-safe','0','-i',f'{d}/list.txt',
  '-vf','fps=30,format=yuv420p','-c:v','libx264','-crf','18','-preset','slow','-movflags','+faststart',out], check=True)
