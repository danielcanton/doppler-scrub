"""Remove aircraft Doppler tones and mains hum from a recording, keep the rest.

Usage:
    python3 scrub.py input.(wav|mp4|mov|m4a) output.(wav|mp4|mov) [--strict] [--plot out.png]

How it works:
  1. STFT with ~0.34 s windows (fine frequency resolution).
  2. Find narrow tones: spectral peaks well above the local noise floor.
  3. Track them over time.
  4. Flag a track if it lasts >= 2 s and either
       - glides monotonically (Doppler: plane, helicopter, passing engine), or
       - sits on a 50/60 Hz mains harmonic (ENF hum).
     --strict also flags every other long steady tone.
  5. Replace the flagged time-frequency cells with noise at the local
     background level, so no silent "hole" traces the same curve.
For video, the picture is copied untouched and container metadata (GPS,
creation time, device) is stripped.
"""
import argparse
import os
import subprocess
import sys
import tempfile

import numpy as np
from scipy.io import wavfile
from scipy.ndimage import median_filter, uniform_filter1d
from math import gcd

from scipy.signal import stft, istft, resample_poly
from scipy.stats import spearmanr

FMIN, FMAX = 60.0, 6000.0   # below ~60 Hz phone mics mostly hear wind and handling
PEAK_DB = 6.0          # how far above the local floor a tone must be (on smoothed power)
SMOOTH_S = 0.3         # detection averages power over this long
MIN_DUR = 1.5          # seconds a tone must last to be considered
MIN_MONO = 0.8         # |Spearman r| of freq vs time to call it a glide
EXTEND_DB = 3.0        # widen the mask while energy is this far above floor
MAX_HALF_WIDTH = 14    # bins
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv"}
ASR = 16000            # analysis rate: covers FMAX, a third of the memory of 48 kHz


# ---------------------------------------------------------------- analysis --
def analyse(x, sr):
    nper = int(round(0.341 * sr / 8)) * 8   # ~0.34 s window, ~2.9 Hz bins at any rate
    hop = nper // 8
    f, tt, Z = stft(x, sr, window="hann", nperseg=nper, noverlap=nper - hop, boundary="zeros")
    return f, tt, Z, nper, hop


def stft_band(x, nper, hop, nb, chunk=256):
    """Hann STFT keeping only the first nb bins, complex64, built in chunks.

    Frames are centred on j*hop (nper//2 zeros padded each side), like scipy's
    boundary='zeros'. Pairs with istft_band(). Uses a fraction of the memory
    of scipy.signal.stft, which matters in a phone browser.
    """
    w = np.hanning(nper + 1)[:-1].astype(np.float32)
    n_frames = int(np.ceil(len(x) / hop)) + 1
    xp = np.zeros((n_frames - 1) * hop + nper, dtype=np.float32)
    xp[nper // 2: nper // 2 + len(x)] = x
    Z = np.empty((nb, n_frames), dtype=np.complex64)
    for j0 in range(0, n_frames, chunk):
        j1 = min(j0 + chunk, n_frames)
        idx = (np.arange(j0, j1) * hop)[:, None] + np.arange(nper)[None, :]
        Z[:, j0:j1] = np.fft.rfft(xp[idx] * w, axis=1)[:, :nb].T
    return Z


def istft_band(D, nper, hop, n_out, chunk=256):
    """Least-squares inverse of stft_band() (weighted overlap-add)."""
    w = np.hanning(nper + 1)[:-1].astype(np.float32)
    n_frames = D.shape[1]
    y = np.zeros((n_frames - 1) * hop + nper, dtype=np.float32)
    wsum = np.zeros_like(y)
    full = np.zeros((nper // 2 + 1, chunk), dtype=np.complex64)
    for j0 in range(0, n_frames, chunk):
        j1 = min(j0 + chunk, n_frames)
        full[:] = 0
        full[: D.shape[0], : j1 - j0] = D[:, j0:j1]
        frames = np.fft.irfft(full[:, : j1 - j0], n=nper, axis=0).T * w
        for k, j in enumerate(range(j0, j1)):
            y[j * hop: j * hop + nper] += frames[k]
            wsum[j * hop: j * hop + nper] += w * w
    y = np.divide(y, wsum, out=np.zeros_like(y), where=wsum > 1e-6)
    return y[nper // 2: nper // 2 + n_out]


def to_rate(x, sr_from, sr_to):
    if sr_from == sr_to:
        return x.astype(np.float32)
    g = gcd(int(sr_from), int(sr_to))
    return resample_poly(x, sr_to // g, sr_from // g).astype(np.float32)


def floor_db(S_db, df=None):
    df = df or ASR / (int(round(0.341 * ASR / 8)) * 8)
    width = max(9, int(150 / df) | 1)  # ~150 Hz median across frequency
    return median_filter(S_db, size=(width, 1), mode="nearest")


def find_peaks(S_db, bg, f, band):
    exc = S_db - bg
    loc = np.ones_like(S_db, dtype=bool)
    for k in (1, 2):
        loc &= S_db >= np.roll(S_db, k, 0)
        loc &= S_db >= np.roll(S_db, -k, 0)
    cand = loc & (exc > PEAK_DB) & band[:, None]
    df = f[1] - f[0]
    peaks = []
    for j in range(S_db.shape[1]):
        idx = np.nonzero(cand[:, j])[0]
        idx = idx[(idx > 0) & (idx < len(f) - 1)]
        a, b, c = S_db[idx - 1, j], S_db[idx, j], S_db[idx + 1, j]
        den = a - 2 * b + c
        off = np.where(np.abs(den) > 1e-9, 0.5 * (a - c) / den, 0.0)
        peaks.append((f[idx] + off * df, exc[idx, j]))
    return peaks


def track(peaks, df, hop_s):
    max_jump = 1.5 * df
    max_gap = int(round(0.3 / hop_s))
    active, done = [], []
    for j, (pf, pe) in enumerate(peaks):
        pairs = []
        for ai, tr in enumerate(active):
            gap = j - tr["t"][-1]
            k = min(len(tr["f"]), 10)
            slope = (tr["f"][-1] - tr["f"][-k]) / max(tr["t"][-1] - tr["t"][-k], 1)
            pred = tr["f"][-1] + slope * gap
            d = np.abs(pf - pred)
            for pi in np.nonzero(d <= max_jump * (1 + 0.3 * (gap - 1)))[0]:
                pairs.append((d[pi], ai, pi))
        pairs.sort()
        used_a, used_p = set(), set()
        for d, ai, pi in pairs:
            if ai in used_a or pi in used_p:
                continue
            used_a.add(ai)
            used_p.add(pi)
            active[ai]["t"].append(j)
            active[ai]["f"].append(pf[pi])
        for pi in range(len(pf)):
            if pi not in used_p:
                active.append({"t": [j], "f": [pf[pi]]})
        keep = []
        for tr in active:
            (keep if j - tr["t"][-1] <= max_gap else done).append(tr)
        active = keep
    return done + active


def classify(tr, hop_s, strict):
    t = np.array(tr["t"])
    f = np.array(tr["f"])
    if (t[-1] - t[0]) * hop_s < MIN_DUR or len(t) < 10:
        return None
    fs = uniform_filter1d(f, size=min(len(f), 9), mode="nearest")
    fmed = float(np.median(fs))
    for base in (50.0, 60.0):
        k = round(fmed / base)
        if 1 <= k <= 40 and abs(fmed - k * base) <= 0.4 + 0.03 * k and np.std(fs) < 0.3 + 0.05 * k:
            return "hum"
    spread = np.percentile(fs, 95) - np.percentile(fs, 5)
    if spread >= max(2.0, 0.006 * fmed):
        r = spearmanr(t, fs).statistic
        if abs(r) >= MIN_MONO:
            return "doppler"
    return "steady" if strict else None


RESIDENT_S = 10.0  # look this far to the other side of a pass for a resident tone


def resident(exc_s, b, j0, j1, thr=2.5):
    """True if a tone sits at bin b for most of frames j0..j1.

    A plane's tail frequency is empty before the plane passes (it was higher
    then), and its head frequency is empty after. A fridge or fan is there on
    both sides. This keeps chain() and follow() off steady local machines.
    """
    j0, j1 = max(j0, 0), min(j1, exc_s.shape[1])
    if j1 - j0 < 5:
        return False
    seg = exc_s[max(b - 1, 0):b + 2, j0:j1].max(axis=0)
    return np.mean(seg > thr) > 0.5


def edge_slopes(tr, hop_s, span_s=1.0):
    """Slope (Hz per frame) over the first and last ~1 s of a track."""
    t, f = np.array(tr["t"]), np.array(tr["f"])
    n = max(2, min(len(t), int(round(span_s / hop_s))))
    a = np.polyfit(t[:n], f[:n], 1)[0] if t[n - 1] > t[0] else 0.0
    b = np.polyfit(t[-n:], f[-n:], 1)[0] if t[-1] > t[-n] else 0.0
    return a, b


def chain(flagged, tracks, hop_s, exc_s, df, min_dur=0.3, max_gap_s=3.0, tol=0.02):
    """Pull in tones that continue a flagged curve before or after it.

    A plane far away gives a flat tone before and after the glide. Leaving
    those flat parts in leaks the speed (high/low frequency ratio) and the
    time of the pass, so they go too.
    """
    max_gap = int(round(max_gap_s / hop_s))
    win = int(round(RESIDENT_S / hop_s))
    ids = {id(tr) for tr, _ in flagged}
    pool = [tr for tr in tracks if id(tr) not in ids and (tr["t"][-1] - tr["t"][0]) * hop_s >= min_dur]
    cache = {}

    def summary(tr):  # tracks don't change during chain(), so compute once
        k = id(tr)
        if k not in cache:
            cache[k] = (np.median(tr["f"][:5]), np.median(tr["f"][-5:])) + edge_slopes(tr, hop_s)
        return cache[k]

    ends = lambda tr: summary(tr)[:2]
    changed = True
    while changed:
        changed = False
        for tr in list(pool):
            t0, f0 = tr["t"][0], ends(tr)[0]
            t1, f1 = tr["t"][-1], ends(tr)[1]
            for ft, label in flagged:
                if label == "hum":
                    continue
                g0, g1 = ends(ft)
                s0, s1 = summary(ft)[2:]
                # extrapolate the flagged curve across the gap before comparing
                p0 = g0 - s0 * (ft["t"][0] - t1)
                p1 = g1 + s1 * (t0 - ft["t"][-1])
                before = 0 <= ft["t"][0] - t1 <= max_gap and abs(f1 - p0) <= tol * g0
                after = 0 <= t0 - ft["t"][-1] <= max_gap and abs(f0 - p1) <= tol * g1
                if before and resident(exc_s, int(round(f1 / df)), ft["t"][-1], ft["t"][-1] + win):
                    before = False
                if after and resident(exc_s, int(round(f0 / df)), ft["t"][0] - win, ft["t"][0]):
                    after = False
                if before or after:
                    flagged.append((tr, "doppler"))
                    pool.remove(tr)
                    changed = True
                    break
    return flagged


def follow(flagged, exc_s, f, hop_s, thr_db=2.5, max_miss_s=1.0):
    """Extend each Doppler track into its faint head and tail.

    Far from the plane the tone drops below the detection threshold but is
    still recoverable by averaging over time. Follow it on a time-smoothed
    excess spectrogram at a much lower threshold.
    """
    df = f[1] - f[0]
    n_frames = exc_s.shape[1]
    max_miss = int(round(max_miss_s / hop_s))
    win = int(round(RESIDENT_S / hop_s))
    for tr, label in flagged:
        if label == "hum":
            continue
        t_first, t_last = tr["t"][0], tr["t"][-1]
        for direction in (1, -1):
            # the far end of the pass: the plane was at another frequency then, so
            # a tone already sitting at the tail/head frequency is a local machine
            other = (t_first - win, t_first + win) if direction == 1 else (t_last - win, t_last + win)
            ts = tr["t"] if direction == 1 else tr["t"][::-1]
            fs = tr["f"] if direction == 1 else tr["f"][::-1]
            k = min(len(ts), 20)
            slope = (fs[-1] - fs[-k]) / max(abs(ts[-1] - ts[-k]), 1) * direction
            fq, j, miss, new = fs[-1], ts[-1], 0, []
            while miss <= max_miss:
                j += direction
                if not 0 <= j < n_frames:
                    break
                slope *= 0.995  # a plane's tail flattens; a car's glide may not
                fq += slope * direction
                c = int(round(fq / df))
                lo, hi = max(c - 1, 1), min(c + 2, len(f) - 1)
                b = lo + int(np.argmax(exc_s[lo:hi, j]))
                if exc_s[b, j] > thr_db and resident(exc_s, b, *other):
                    break
                if exc_s[b, j] > thr_db:
                    fq, miss = f[b], 0
                    new.append((j, fq))
                else:
                    miss += 1
                    new.append((j, fq))
            new = new[: len(new) - miss]  # drop the trailing misses
            if direction == 1:
                tr["t"] += [p[0] for p in new]
                tr["f"] += [p[1] for p in new]
            else:
                tr["t"][:0] = [p[0] for p in new][::-1]
                tr["f"][:0] = [p[1] for p in new][::-1]
    return flagged


# ----------------------------------------------------------------- removal --
def build_mask(flagged, exc, f, n_frames, hop_s):
    df = f[1] - f[0]
    pad = int(round(0.35 / hop_s))
    mask = np.zeros(exc.shape, dtype=bool)
    # Mains hum is always on. Once 50 or 60 Hz mains is confirmed (2+ hum tracks),
    # take its first 10 harmonics out of the whole file: weak harmonics hidden
    # under other sounds show up again once those sounds are removed.
    hum_f = [float(np.median(tr["f"])) for tr, c in flagged if c == "hum"]
    whole = []
    for base in (50.0, 60.0):
        if sum(abs(fq / base - round(fq / base)) * base < 1.0 for fq in hum_f) >= 2:
            whole += [{"t": [0, n_frames - 1], "f": [k * base] * 2} for k in range(1, 11)]
    for tr in [tr for tr, c in flagged if c != "hum"] + whole:
        t = np.array(tr["t"])
        fr = np.array(tr["f"])
        start = 0 if t[0] <= 3 * pad else t[0] - pad
        end = n_frames - 1 if t[-1] >= n_frames - 1 - 3 * pad else t[-1] + pad
        frames = np.arange(start, end + 1)
        fc = np.interp(frames, t, fr)
        for j, fq in zip(frames, fc):
            c = int(round(fq / df))
            lo, hi = c - 2, c + 2
            # widen down the skirt of this tone only; stop where a neighbour rises
            while (lo > 0 and c - lo < MAX_HALF_WIDTH and exc[lo - 1, j] > EXTEND_DB
                   and exc[lo - 1, j] <= exc[lo, j] + 1):
                lo -= 1
            while (hi < len(f) - 1 and hi - c < MAX_HALF_WIDTH and exc[hi + 1, j] > EXTEND_DB
                   and exc[hi + 1, j] <= exc[hi, j] + 1):
                hi += 1
            mask[max(lo, 0):hi + 1, j] = True
    return mask


def fill_values(Zb, mask, noise_Zb):
    """Noise shaped to the local floor for the masked cells.

    noise_Zb is the STFT of real white noise, so its cells are consistent
    across overlapping frames. Independent random cells would partly cancel
    in the overlap-add and leave a darker 'hole' that traces the removed curve.
    """
    floor = floor_db((20 * np.log10(np.abs(Zb) + 1e-12)).astype(np.float32), None)
    unit = noise_Zb / np.median(np.abs(noise_Zb))
    return unit[mask] * 10 ** (floor[mask] / 20)


def scrub(audio, sr, strict=False, seed=0, progress=None):
    """audio: (n,) or (n, ch) float. Returns (clean, report).

    Analysis and removal run at ASR on the band below FMAX. Only the
    difference (removed tones -> noise fill) is resampled back and added to
    the original, so audio outside the masked cells is bit-for-bit untouched.
    """
    say = progress or (lambda msg: None)
    multi = audio.ndim == 2
    chans = (audio.T if multi else audio[None, :]).astype(np.float32)

    say("analysing")
    mono = to_rate(chans.mean(axis=0), sr, ASR)
    nper = int(round(0.341 * ASR / 8)) * 8
    hop = nper // 8
    hop_s = hop / ASR
    f_all = np.fft.rfftfreq(nper, 1 / ASR)
    nb = int(np.searchsorted(f_all, FMAX + 400))   # rows we ever touch, plus floor margin
    f = f_all[:nb]
    Z = stft_band(mono, nper, hop, nb)
    tt = np.arange(Z.shape[1]) * hop_s
    band = (f >= FMIN) & (f <= FMAX)
    # Detect on power averaged over ~0.3 s: a slow glide barely moves in that
    # time, while noise averages down, so faint real-world tones stand out.
    P = uniform_filter1d(np.abs(Z) ** 2, size=max(1, int(round(SMOOTH_S / hop_s))), axis=1)
    del Z
    S_db = (10 * np.log10(P + 1e-24)).astype(np.float32)
    del P
    bg = floor_db(S_db, f[1] - f[0])
    say("tracking tones")
    peaks = find_peaks(S_db, bg, f, band)
    tracks = track(peaks, f[1] - f[0], hop_s)
    flagged = [(tr, c) for tr in tracks if (c := classify(tr, hop_s, strict))]
    exc = S_db - bg
    exc_s = uniform_filter1d(exc, size=max(3, int(round(0.5 / hop_s))), axis=1)
    flagged = chain(flagged, tracks, hop_s, exc_s, f[1] - f[0])
    flagged = follow(flagged, exc_s, f, hop_s)
    mask = build_mask(flagged, exc, f, len(tt), hop_s)
    del exc_s, bg

    say("removing")
    rng = np.random.default_rng(seed)
    out = []
    for ch in chans:
        if not mask.any():
            out.append(ch)
            continue
        xa = to_rate(ch, sr, ASR)
        Zc = stft_band(xa, nper, hop, nb)
        Zn = stft_band(rng.standard_normal(len(xa)).astype(np.float32), nper, hop, nb)
        D = np.zeros_like(Zc)
        D[mask] = fill_values(Zc, mask, Zn) - Zc[mask]
        del Zc, Zn
        d = to_rate(istft_band(D, nper, hop, len(xa)), ASR, sr)
        del D
        n = min(len(d), len(ch))
        y = ch.copy()
        y[:n] += d[:n]
        out.append(y)
    clean = np.stack(out, axis=1) if multi else out[0]

    report = {
        "doppler_tracks": sum(c == "doppler" for _, c in flagged),
        "hum_tracks": sum(c == "hum" for _, c in flagged),
        "steady_tracks": sum(c == "steady" for _, c in flagged),
        "masked_cells_pct": 100 * mask[band].mean(),
        "flagged": flagged,
        "analysis": (f, tt, S_db, hop_s),
    }
    return clean, report


# --------------------------------------------------------------------- I/O --
def load(path, tmp):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".wav":
        try:
            sr, x = wavfile.read(path)
            return sr, to_float(x)
        except ValueError:
            pass
    wav = os.path.join(tmp, "in.wav")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-vn", "-c:a", "pcm_f32le", wav], check=True)
    sr, x = wavfile.read(wav)
    return sr, to_float(x)


def to_float(x):
    if x.dtype.kind == "i":
        return x.astype(np.float32) / np.iinfo(x.dtype).max
    return x.astype(np.float32)


def save(path, src, sr, y, tmp):
    ext = os.path.splitext(path)[1].lower()
    y = np.clip(y, -1, 1).astype(np.float32)
    if ext == ".wav":
        wavfile.write(path, sr, y)
        return
    wav = os.path.join(tmp, "out.wav")
    wavfile.write(wav, sr, y)
    if ext in VIDEO_EXT:
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", src, "-i", wav,
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
               "-map_metadata", "-1", "-map_chapters", "-1", "-fflags", "+bitexact",
               "-flags:v", "+bitexact", "-flags:a", "+bitexact", path]
    else:
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", wav, "-map_metadata", "-1", path]
    subprocess.run(cmd, check=True)


def auto_fmax(flagged, default=2000.0):
    """Top of the display: just above the highest removed tone, on a round step."""
    tops = [max(tr["f"]) for tr, c in flagged]
    if not tops:
        return default
    top = 1.35 * max(tops)
    for step in (250, 500, 1000):
        if top <= step * 4:
            return float(min(max(np.ceil(top / step) * step, 500), 4000))
    return 4000.0


def spectrogram_images(x, clean, sr, fmax=2000.0, width=1000, range_db=50.0):
    """Before / after / removed spectrograms as uint8 images (rows = low->high freq).

    One scale for all three, so a removed curve reads as gone, not as darker.
    "Removed" is the spectrogram of (before - after): only what was taken out.
    Used by the web app, which paints them onto canvases.
    """
    nper = int(round(0.341 * ASR / 8)) * 8
    hop = nper // 8
    nb = int(np.searchsorted(np.fft.rfftfreq(nper, 1 / ASR), fmax)) + 1
    mono = lambda s: s.mean(axis=1) if s.ndim == 2 else s
    xb, xa = mono(x), mono(clean)
    imgs = []
    for sig in (xb, xa, xb - xa):
        S = 20 * np.log10(np.abs(stft_band(to_rate(sig, sr, ASR), nper, hop, nb)) + 1e-9)
        step = max(1, int(np.ceil(S.shape[1] / width)))
        cols = S.shape[1] // step * step
        imgs.append(S[:, :cols].reshape(nb, -1, step).max(axis=2) if cols else S)
    vmax = np.percentile(imgs[0], 99.5)
    out = [np.clip((im - (vmax - range_db)) / range_db * 255, 0, 255).astype(np.uint8) for im in imgs]
    meta = {"rows": int(nb), "cols": int(out[0].shape[1]), "fmax": float(fmax), "duration": len(x) / sr}
    return out[0], out[1], out[2], meta


def spectrogram_db(x, sr):
    mono = x.mean(axis=1) if x.ndim == 2 else x
    f, tt, Z, _, _ = analyse(mono, sr)
    return f, tt, 20 * np.log10(np.abs(Z) + 1e-12)


def plot(x, clean, sr, path, fmax=2000):
    """Before/after spectrograms of the raw signals, same scale."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    f, tt, Sb = spectrogram_db(x, sr)
    _, _, Sa = spectrogram_db(clean, sr)
    k = f <= fmax
    vmax = np.percentile(Sb[k], 99.5)
    fig, ax = plt.subplots(2, 1, figsize=(14, 8), sharex=True, sharey=True)
    for a, S, title in ((ax[0], Sb, "Before"), (ax[1], Sa, "After")):
        a.pcolormesh(tt, f[k], S[k], vmin=vmax - 50, vmax=vmax, cmap="magma", shading="auto")
        a.set_title(title)
        a.set_ylabel("Hz")
    ax[1].set_xlabel("seconds")
    ax[0].set_ylim(0, fmax)
    fig.tight_layout()
    fig.savefig(path, dpi=110)


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--strict", action="store_true", help="also remove every long steady tone")
    p.add_argument("--plot", help="write a before/after spectrogram PNG")
    p.add_argument("-v", "--verbose", action="store_true", help="list every removed track")
    p.add_argument("--plot-fmax", type=float, default=2000, help="top of the plot in Hz (default 2000)")
    a = p.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        sr, x = load(a.input, tmp)
        y, rep = scrub(x, sr, strict=a.strict)
        save(a.output, a.input, sr, y, tmp)
    if a.verbose:
        _, tt, _, _ = rep["analysis"]
        for tr, c in rep["flagged"]:
            print(f"  {c:8s} {tt[tr['t'][0]]:6.1f}-{tt[tr['t'][-1]]:6.1f} s  {tr['f'][0]:7.1f} -> {tr['f'][-1]:7.1f} Hz")
    print(f"doppler tracks removed: {rep['doppler_tracks']}  hum: {rep['hum_tracks']}  "
          f"steady: {rep['steady_tracks']}  cells changed (20 Hz-6 kHz): {rep['masked_cells_pct']:.2f}%")
    if a.plot:
        plot(x, y, sr, a.plot, fmax=a.plot_fmax)
        print(f"plot: {a.plot}")


if __name__ == "__main__":
    sys.exit(main())
