// Runs scrub.py in Pyodide, off the main thread.
// In:  {type:'run', pcm:ArrayBuffer (float32, planar), channels, sampleRate, strict}
// Out: {type:'status', msg} | {type:'ready'} | {type:'done', pcm, before, after, removed, meta} | {type:'error', msg}
importScripts('https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js');

const BRIDGE = `
import json
import numpy as np
import scrub

def run(pcm, channels, sr, strict, progress):
    sr = int(sr)
    x = np.frombuffer(pcm.to_py(), dtype=np.float32).reshape(int(channels), -1).T.copy()
    if x.shape[1] == 1:
        x = x[:, 0]
    y, rep = scrub.scrub(x, sr, strict=bool(strict), progress=progress)
    progress("drawing spectrograms")
    fmax = scrub.auto_fmax(rep["flagged"])
    before, after, removed, meta = scrub.spectrogram_images(x, y, sr, fmax=fmax)
    _, tt, _, hop_s = rep["analysis"]
    every = max(1, int(round(0.2 / hop_s)))   # ~5 points per second is plenty to draw
    meta.update({
        "doppler": rep["doppler_tracks"],
        "hum": rep["hum_tracks"],
        "steady": rep["steady_tracks"],
        "changed_pct": round(float(rep["masked_cells_pct"]), 2),
        "tracks": [
            {"kind": c, "t0": round(float(tt[tr["t"][0]]), 2), "t1": round(float(tt[tr["t"][-1]]), 2),
             "f0": round(float(tr["f"][0]), 1), "f1": round(float(tr["f"][-1]), 1),
             "pts": [[round(float(tt[j]), 2), round(float(fq), 1)]
                     for j, fq in list(zip(tr["t"], tr["f"]))[::every] + [(tr["t"][-1], tr["f"][-1])]]}
            for tr, c in rep["flagged"]
        ],
    })
    y = np.clip(y, -1, 1).astype(np.float32)
    planar = (y.T if y.ndim == 2 else y[None, :]).copy()
    return planar.tobytes(), before.tobytes(), after.tobytes(), removed.tobytes(), json.dumps(meta)
`;

let ready = null;

async function init() {
  postMessage({ type: 'status', msg: 'Loading Python engine' });
  const py = await loadPyodide();
  postMessage({ type: 'status', msg: 'Loading numpy and scipy' });
  await py.loadPackage(['numpy', 'scipy']);
  const src = await (await fetch('scrub.py', { cache: 'no-cache' })).text();
  py.FS.writeFile('/home/pyodide/scrub.py', src);
  py.runPython('import sys; sys.path.insert(0, "/home/pyodide")');
  py.runPython(BRIDGE);
  postMessage({ type: 'ready' });
  return py;
}

self.onmessage = async (e) => {
  const { type } = e.data;
  try {
    if (!ready) ready = init();
    const py = await ready;
    if (type !== 'run') return;
    const run = py.globals.get('run');
    const progress = (msg) => postMessage({ type: 'status', msg: String(msg) });
    const res = run(new Uint8Array(e.data.pcm), e.data.channels, e.data.sampleRate, e.data.strict, progress);
    const [pcm, before, after, removed, meta] = res.toJs();
    res.destroy();
    run.destroy();
    const out = { type: 'done', pcm: pcm.buffer, before: before.buffer, after: after.buffer, removed: removed.buffer, meta: JSON.parse(meta) };
    postMessage(out, [out.pcm, out.before, out.after, out.removed]);
  } catch (err) {
    postMessage({ type: 'error', msg: String(err && err.message ? err.message : err) });
  }
};
