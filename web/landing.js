// Landing page: the drag-to-compare demo (procedural spectrogram, two flyovers + hum).
(() => {
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const isDark = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }; };
  const C = 343, FMAX = 600;
  const recv = (p, t) => { const x = p.v * (t - p.t0), r = Math.hypot(x, p.d); return { ratio: C / (C + p.v * x / r), amp: p.d / r }; };
  // --------------------------------------------------------------- compare --
  const cmp = $('cmp'), cmpCanvas = $('cmp-canvas'), range = $('cmp-range'), handle = $('cmp-handle');
  let imgBefore = null, imgAfter = null, cmpSize = '';
  function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const sx = xf * xf * (3 - 2 * xf), sy = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
  function drawCompare(force) {
    const dpr = Math.min(devicePixelRatio, 2);
    const w = Math.max(1, Math.round(cmp.clientWidth * dpr)), h = Math.max(1, Math.round(cmp.clientHeight * dpr));
    const key = `${w}x${h}x${isDark()}`;
    if (force || key !== cmpSize) {
      cmpSize = key;
      cmpCanvas.width = w; cmpCanvas.height = h;
      const field = hex(css('--field')), sig = hex(css('--signal')), bg = hex(css('--surface'));
      const mk = (withTones) => {
        const img = new ImageData(w, h), D2 = img.data;
        const flights = [{ t0: 34, f0: 98, v: 75, d: 420 }, { t0: 88, f0: 132, v: 68, d: 360 }];
        for (let x = 0; x < w; x++) {
          const t = (x / w) * 120;
          const tones = flights.map((p) => recv(p, t));
          for (let y = 0; y < h; y++) {
            const f = (1 - y / h) * FMAX;
            let lev = 0.22 + 0.5 * vnoise(t * 0.6, f / 28) * vnoise(t * 3.1, f / 6) + 0.35 * Math.exp(-f / 50);
            lev *= 0.75 + 0.5 * hash(x, y);
            let tone = 0;
            if (withTones) {
              flights.forEach((p, i) => {
                const { ratio, amp } = tones[i];
                for (let k = 1; k <= 4; k++) { const d = (f - p.f0 * k * ratio) / 3.2; tone += (amp > 0.18 ? amp : 0) * Math.exp(-d * d) / Math.pow(k, 0.55); }
              });
              for (let k = 1; k <= 6; k++) { const d = (f - 50 * k) / 1.6; tone += 0.35 * Math.exp(-d * d); }
            }
            lev = Math.min(lev, 1);
            const s = Math.min(tone * 1.6, 1), o = (y * w + x) * 4;
            const r = bg.r + (field.r - bg.r) * lev * 0.85, g = bg.g + (field.g - bg.g) * lev * 0.85, b = bg.b + (field.b - bg.b) * lev * 0.85;
            D2[o] = 255 * (r + (sig.r - r) * s); D2[o + 1] = 255 * (g + (sig.g - g) * s); D2[o + 2] = 255 * (b + (sig.b - b) * s); D2[o + 3] = 255;
          }
        }
        return img;
      };
      imgBefore = mk(true); imgAfter = mk(false);
    }
    const ctx = cmpCanvas.getContext('2d');
    const split = Math.round((range.value / 100) * w);
    ctx.putImageData(imgBefore, 0, 0);
    ctx.putImageData(imgAfter, 0, 0, 0, 0, split, h);
    handle.style.left = range.value + '%';
  }
  range.addEventListener('input', () => drawCompare(false));
  const dragTo = (e) => { const r = cmp.getBoundingClientRect(); range.value = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)); drawCompare(false); };
  let dragging = false;
  cmp.addEventListener('pointerdown', (e) => { dragging = true; cmp.setPointerCapture(e.pointerId); dragTo(e); });
  cmp.addEventListener('pointermove', (e) => dragging && dragTo(e));
  cmp.addEventListener('pointerup', () => { dragging = false; });
  addEventListener('resize', () => drawCompare(false));

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => drawCompare(true));
  new MutationObserver(() => drawCompare(true)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  drawCompare(true);
})();
