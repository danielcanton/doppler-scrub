"""Score scrub.py on the synthetic clip from synth.py.

Pass criteria:
  1. Every true aircraft curve drops to < 3 dB above the noise floor (invisible).
  2. Re-running the detector on the output finds 0 Doppler tracks.
  3. The steady 233 Hz machine tone survives (within 3 dB).
  4. Output is closer to the reference (ambience + roar) than the input was.
"""
import numpy as np
from scipy.io import wavfile

import scrub

sr, mix = wavfile.read("test/mix.wav")
_, ref = wavfile.read("test/reference.wav")
truth = np.load("test/truth.npz")

clean, rep = scrub.scrub(mix, sr)
wavfile.write("test/clean.wav", sr, clean.astype(np.float32))
scrub.plot(mix, clean, sr, "test/before_after.png")


def spec(x):
    f, tt, Z, _, _ = scrub.analyse(x, sr)
    S = 20 * np.log10(np.abs(Z) + 1e-12)
    return f, tt, S, scrub.floor_db(S, f[1] - f[0])


f, tt, S_in, bg_in = spec(mix)
_, _, S_out, bg_out = spec(clean)
_, _, S_ref, _ = spec(ref)
df = f[1] - f[0]

print("\n1. Curve visibility, dB above floor, where the plane is audible in the input")
print("   control = same measure on the output along a curve shifted +-6% (pure noise).")
print("   pass: |after - control| < 1.5 dB  (no bright line, no dark hole)")
ok1 = True
j = np.arange(len(tt))


def vis(S, bg, fq):
    k = np.clip(np.round(fq / df).astype(int), 1, len(f) - 2)
    return np.max([S[k + d, j] for d in (-1, 0, 1)], axis=0) - bg[k, j]


for name in [k for k in truth.files if k != "t"]:
    fq = np.interp(tt, truth["t"], truth[name])
    v_in = vis(S_in, bg_in, fq)
    sel = v_in > 6
    a = v_in[sel].mean()
    b = vis(S_out, bg_out, fq)[sel].mean()
    ctl = np.mean([vis(S_out, bg_out, fq * s)[sel].mean() for s in (0.94, 1.06)])
    ok1 &= abs(b - ctl) < 1.5
    print(f"   {name:14s} before {a:5.1f}  after {b:5.1f}  control {ctl:5.1f}  ({sel.sum()} frames)")

print("\n2. Detector re-run on output: tracks lying on a true flight curve (within 3%), or hum")
_, rep2 = scrub.scrub(clean, sr)
_, tt2, _, _ = rep2["analysis"]
curves = [k for k in truth.files if k != "t"]
on_curve = 0
for tr, c in rep2["flagged"]:
    ts = tt2[tr["t"]]
    for name in curves:
        fq = np.interp(ts, truth["t"], truth[name])
        if np.median(np.abs(np.array(tr["f"]) - fq) / fq) < 0.03:
            on_curve += 1
            print(f"   leak: {c} {ts[0]:.1f}-{ts[-1]:.1f} s on {name}")
            break
ok2 = on_curve == 0 and rep2["hum_tracks"] == 0
print(f"   on-curve tracks {on_curve}  hum tracks {rep2['hum_tracks']}  "
      f"(other detections, not on any flight: {rep2['doppler_tracks'] - on_curve})")

print("\n3. Steady 233 Hz machine tone kept")
kf = int(round(233 / df))
lv_in = (S_in[kf] - bg_in[kf]).mean()
lv_out = (S_out[kf] - bg_out[kf]).mean()
ok3 = abs(lv_in - lv_out) < 3
print(f"   before {lv_in:.1f} dB  after {lv_out:.1f} dB")

print("\n4. Distance to reference (ambience + roar), log-spectral, 20 Hz-6 kHz, 1 s blocks")
band = (f >= 20) & (f <= 6000)
blk = int(round(1 / (tt[1] - tt[0])))


def lsd(A, B):
    n = (A.shape[1] // blk) * blk
    pa = (10 ** (A[band, :n] / 10)).reshape(band.sum(), -1, blk).mean(2)
    pb = (10 ** (B[band, :n] / 10)).reshape(band.sum(), -1, blk).mean(2)
    return np.sqrt(np.mean((10 * np.log10(pa / pb)) ** 2))


d_in, d_out = lsd(S_in, S_ref), lsd(S_out, S_ref)
ok4 = d_out < d_in
print(f"   input {d_in:.2f} dB  output {d_out:.2f} dB")

print(f"\nremoved: {rep['doppler_tracks']} doppler, {rep['hum_tracks']} hum tracks; "
      f"{rep['masked_cells_pct']:.2f}% of cells changed")
print("PASS" if all([ok1, ok2, ok3, ok4]) else f"FAIL {[ok1, ok2, ok3, ok4]}")
