"""Make a test clip with known aircraft Doppler curves.

Writes test/mix.wav, test/reference.wav (what a perfect scrub should leave:
ambience + jet roar, no aircraft tones, no mains hum) and test/truth.npz
(the true received frequency of every aircraft tone over time).
"""
import os
import numpy as np
from scipy.io import wavfile
from scipy.signal import lfilter, butter, sosfilt

SR = 48000
DUR = 120.0
C = 343.0
rng = np.random.default_rng(7)
n = int(SR * DUR)
t = np.arange(n) / SR


def pink(n):
    b = [0.049922035, -0.095993537, 0.050612699, -0.004408786]
    a = [1, -2.494956002, 2.017265875, -0.522189400]
    x = lfilter(b, a, rng.standard_normal(n))
    return x / np.std(x)


def smooth_noise(n, cutoff_hz):
    sos = butter(2, cutoff_hz, fs=SR, output="sos")
    x = sosfilt(sos, rng.standard_normal(n))
    return x / (np.std(x) + 1e-12)


def flyover(t0, speed, alt, offset):
    """Received frequency ratio and 1/r gain for a straight, level pass.

    Plane at (speed*(te-t0), offset, alt); observer at the origin.
    Accounts for propagation delay: sound emitted at te arrives at te + r/c.
    """
    te = np.linspace(-200, DUR + 200, 400000)
    x = speed * (te - t0)
    r = np.sqrt(x**2 + offset**2 + alt**2)
    vr = speed * x / r  # radial speed, + = moving away
    ta = te + r / C
    ratio = C / (C + vr)
    rmin = np.sqrt(offset**2 + alt**2)
    return np.interp(t, ta, ratio), np.interp(t, ta, rmin / r)


def tone(freq_t, amp_t):
    phase = 2 * np.pi * np.cumsum(freq_t) / SR + rng.uniform(0, 2 * np.pi)
    return amp_t * np.sin(phase)


# --- ambience -------------------------------------------------------------
amb = 0.02 * pink(n)

# birds: short, fast chirps (should be kept)
birds = np.zeros(n)
for _ in range(60):
    s = rng.uniform(0, DUR - 1)
    d = rng.uniform(0.08, 0.3)
    i0, i1 = int(s * SR), int((s + d) * SR)
    tt = np.arange(i1 - i0) / SR
    f0, f1 = rng.uniform(2500, 3500), rng.uniform(3500, 4800)
    f = f0 + (f1 - f0) * tt / d
    env = np.sin(np.pi * tt / d) ** 2
    birds[i0:i1] += 0.03 * env * np.sin(2 * np.pi * np.cumsum(f) / SR)

# voice-like: syllables with moving pitch and harmonics (should be kept)
voice = np.zeros(n)
for seg_start in (10, 50, 75, 100):
    s = seg_start
    while s < seg_start + 12:
        d = rng.uniform(0.12, 0.35)
        i0, i1 = int(s * SR), int((s + d) * SR)
        tt = np.arange(i1 - i0) / SR
        f0 = rng.uniform(110, 170) * (1 + 0.15 * np.sin(2 * np.pi * tt / d))
        env = np.sin(np.pi * tt / d) ** 1.5
        ph = 2 * np.pi * np.cumsum(f0) / SR
        for h in range(1, 25):
            fh = h * f0.mean()
            w = np.exp(-((fh - 600) / 500) ** 2) + 0.4 * np.exp(-((fh - 1800) / 600) ** 2) + 0.05
            voice[i0:i1] += 0.012 * w * env * np.sin(h * ph)
        s += d + rng.uniform(0.03, 0.2)

# steady machine tone, not mains-locked (should be kept)
fridge = 0.012 * np.sin(2 * np.pi * 233.0 * t)

ambience = amb + birds + voice + fridge

# --- mains hum with ENF drift (should be removed) --------------------------
enf = 50 + 0.03 * smooth_noise(n, 0.05)
hum = sum(a * np.sin(2 * np.pi * k * np.cumsum(enf) / SR) for k, a in [(1, 0.012), (2, 0.008), (3, 0.005), (4, 0.003)])

# --- aircraft ---------------------------------------------------------------
truth = {}
tones = np.zeros(n)
roar = np.zeros(n)

# turboprop: blade-pass 98 Hz + harmonics, low and slow
ratio, g = flyover(t0=35, speed=75, alt=600, offset=300)
turb = 1 + 0.3 * smooth_noise(n, 0.5)
for h, a in [(1, 0.05), (2, 0.035), (3, 0.025), (4, 0.015), (5, 0.01)]:
    f = 98.0 * h * ratio
    tones += tone(f, a * g * turb)
    truth[f"turboprop_h{h}"] = f[:: SR // 100]
roar += 0.05 * g * sosfilt(butter(2, 800, fs=SR, output="sos"), pink(n))

# jet: fan tone 1150 Hz + 2nd harmonic, higher and faster, plus broadband roar
ratio, g = flyover(t0=88, speed=110, alt=1200, offset=400)
for h, a in [(1, 0.03), (2, 0.012)]:
    f = 1150.0 * h * ratio
    tones += tone(f, a * g * turb)
    truth[f"jet_h{h}"] = f[:: SR // 100]
roar += 0.12 * g * sosfilt(butter(2, 1500, fs=SR, output="sos"), pink(n))

mix = ambience + hum + tones + roar
reference = ambience + roar
peak = np.max(np.abs(mix)) / 0.9

os.makedirs("test", exist_ok=True)
wavfile.write("test/mix.wav", SR, (mix / peak).astype(np.float32))
wavfile.write("test/reference.wav", SR, (reference / peak).astype(np.float32))
np.savez("test/truth.npz", t=t[:: SR // 100], **truth)
print("wrote test/mix.wav, test/reference.wav, test/truth.npz")
