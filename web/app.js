// Doppler Scrub app: record or pick a video, clean its audio in the browser, give back a clean copy.
// media.js reads and writes the file (Mediabunny + the browser's own codecs); a Pyodide worker runs
// scrub.py. Nothing is uploaded.
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const rgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// ---------------------------------------------------------------- engines --
let media = null, worker = null, workerLoad = null, job = null;
let engineStatus = () => {};

function engines(onStatus) {
  if (onStatus) engineStatus = onStatus;
  if (!media) media = import('./media.js');
  if (!worker) {
    worker = new Worker('py-worker.js');
    workerLoad = new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') resolve();
        else if (m.type === 'status') (job ? job.status : engineStatus)(m.msg);
        else if (m.type === 'done') job?.resolve(m);
        else if (m.type === 'error') (job ? job.reject : reject)(new Error(m.msg));
      };
    });
    worker.postMessage({ type: 'init' });
  }
  return Promise.all([media, workerLoad]);
}

function runScrub(channels, sampleRate, strict, status) {
  const n = channels[0].length, pcm = new Float32Array(n * channels.length);
  channels.forEach((c, i) => pcm.set(c, i * n));
  return new Promise((resolve, reject) => {
    job = { resolve, reject, status };
    worker.postMessage({ type: 'run', pcm: pcm.buffer, channels: channels.length, sampleRate, strict }, [pcm.buffer]);
  }).finally(() => { job = null; });
}

// ------------------------------------------------------------------ views --
const VIEWS = ['home', 'camera', 'work', 'result'];
function show(id) {
  VIEWS.forEach((v) => { $(v).hidden = v !== id; });
  scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}
const STEPS = ['engine', 'extract', 'scrub', 'mux'];
const li = (name) => document.querySelector(`#steps li[data-step="${name}"]`);
function step(name, state, info) {
  const el = li(name);
  el.classList.remove('active', 'done');
  if (state) el.classList.add(state);
  if (info !== undefined) el.querySelector('.info').textContent = info;
}
function detail(msg, isError) {
  $('detail').textContent = msg || '';
  $('detail').style.color = isError ? 'var(--signal)' : '';
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------- processing --
let outURL = null, outFile = null;

async function processMedia(blob, name) {
  show('work');
  STEPS.forEach((s) => step(s, null, ''));
  $('work-actions').hidden = true;
  $('work-file').textContent = name;
  detail('');
  const strict = $('strict').checked;
  try {
    // Check the container before anything parses it (see inspect.js).
    if (blob.size > 1.5e9) throw new Error('This file is over 1.5 GB. Trim it to a few minutes and try again.');
    inspectMedia(new Uint8Array(await blob.arrayBuffer()));

    step('engine', 'active');
    detail('The first run downloads the engine, then it is cached.');
    const t0 = performance.now();
    const [{ readAudio, writeClean }] = await engines((m) => detail(m));
    step('engine', 'done', `${((performance.now() - t0) / 1000).toFixed(1)} s`);

    step('extract', 'active');
    detail('');
    const src = await readAudio(blob, (p) => detail(`Decoding audio ${Math.round(p * 100)}%`));
    step('extract', 'done', `${(src.channels[0].length / src.sampleRate).toFixed(1)} s · ${src.sampleRate / 1000} kHz`);

    step('scrub', 'active');
    detail('');
    const res = await runScrub(src.channels, src.sampleRate, strict, (m) => detail(cap(m)));
    const n = res.meta.doppler + res.meta.hum + res.meta.steady;
    step('scrub', 'done', n ? `${n} removed` : 'nothing found');

    step('mux', 'active');
    const flat = new Float32Array(res.pcm), len = flat.length / src.channels.length;
    const clean = src.channels.map((_, c) => flat.subarray(c * len, (c + 1) * len));
    const out = await writeClean(src, clean, (p) => detail(`Encoding ${Math.round(p * 100)}%`));
    detail('');
    step('mux', 'done', `${(out.buffer.byteLength / 1e6).toFixed(1)} MB · ${out.acodec.toUpperCase()}${out.encoder === 'wasm' ? ' (wasm)' : ''}`);

    const stem = name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 60) || 'video';
    outFile = new File([out.buffer], `${stem}-clean.${out.ext}`, { type: out.type });
    last = { src, clean, stem };
    showResult(res, !!src.video, name);
    offerSmaller();
  } catch (err) {
    console.error(err);
    STEPS.forEach((s) => li(s).classList.remove('active'));
    detail(err.message || String(err), true);
    $('work-actions').hidden = false;
  }
}

// --------------------------------------------------------- smaller copy --
// The clean audio stays in memory, so a smaller copy only re-encodes the picture.
let last = null, smallFile = null, smallURL = null;
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

async function offerSmaller() {
  const btn = $('btn-smaller');
  btn.hidden = true; btn.disabled = false;
  $('btn-download-small').hidden = true;
  if (smallURL) { URL.revokeObjectURL(smallURL); smallURL = null; }
  smallFile = null;
  if (!last || !last.src.video) return;
  let plan = null;
  try { plan = await (await media).planShrink(last.src); } catch { return; }
  if (!plan) return;                                   // already compact: nothing to offer
  last.plan = plan;
  const estimate = (plan.bitrate + 192000) * last.src.duration / 8;
  btn.textContent = `Make smaller · about ${mb(estimate)}`;
  btn.hidden = false;
}

async function makeSmaller() {
  const btn = $('btn-smaller');
  btn.disabled = true;
  btn.textContent = 'Making smaller…';
  try {
    const { writeClean } = await media;
    const out = await writeClean(last.src, last.clean, (p) => { btn.textContent = `Making smaller · ${Math.round(p * 100)}%`; }, { smaller: true });
    const p = out.shrink ? Math.min(out.shrink.width, out.shrink.height) : 0;
    smallFile = new File([out.buffer], `${last.stem}-clean${p ? '-' + p + 'p' : ''}.${out.ext}`, { type: out.type });
    smallURL = URL.createObjectURL(smallFile);
    const a = $('btn-download-small');
    a.href = smallURL; a.download = smallFile.name;
    a.textContent = `Download smaller · ${mb(smallFile.size)}`;
    a.hidden = false;
    btn.hidden = true;
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = `Couldn't make it smaller: ${err.message}`;
  }
}
$('btn-smaller').onclick = makeSmaller;

// ----------------------------------------------------------------- result --
let spec = null, mode = 'compare';

function showResult(res, hasVideo, name) {
  if (outURL) URL.revokeObjectURL(outURL);
  outURL = URL.createObjectURL(outFile);
  $('out-video').hidden = !hasVideo;
  $('out-audio').hidden = hasVideo;
  (hasVideo ? $('out-video') : $('out-audio')).src = outURL;
  $('btn-download').href = outURL;
  $('btn-download').download = outFile.name;
  $('btn-download').textContent = hasVideo ? `Download · ${mb(outFile.size)}` : 'Download';
  $('btn-share').hidden = !(navigator.canShare && navigator.canShare({ files: [outFile] }));
  $('res-file').textContent = name;

  const m = res.meta;
  $('s-doppler').textContent = m.doppler + m.steady;
  $('s-hum').textContent = m.hum ? `${m.hum} harmonic${m.hum > 1 ? 's' : ''}` : 'None';
  $('s-changed').textContent = `${m.changed_pct}%`;
  $('x-end').textContent = `${m.duration.toFixed(1)} s`;

  spec = { m, before: new Uint8Array(res.before), after: new Uint8Array(res.after), removed: new Uint8Array(res.removed), imgs: null };
  setMode('compare');
  show('result');
  buildImages();
  drawCompare();
  drawAxis();

  const tb = document.querySelector('.tracks tbody');
  tb.innerHTML = '';
  const kinds = { doppler: 'Moving source', hum: 'Mains hum', steady: 'Steady tone' };
  m.tracks.slice().sort((a, b) => a.t0 - b.t0).forEach((t) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="k">${kinds[t.kind] || t.kind}</td><td>${t.t0.toFixed(1)}–${t.t1.toFixed(1)} s</td><td>${Math.round(t.f0)} → ${Math.round(t.f1)} Hz</td>`;
    tb.appendChild(tr);
  });
  if (!m.tracks.length) tb.innerHTML = '<tr><td colspan="3">Nothing found. No moving engines or hum in this clip.</td></tr>';
}

// Paint the worker's uint8 spectrograms in brand colours: sound in --field
// over --surface, removed tones in --signal. Low frequencies at the bottom.
function buildImages() {
  if (!spec) return;
  const { rows, cols } = spec.m;
  const bg = rgb(css('--surface')), fld = rgb(css('--field')), sig = rgb(css('--signal'));
  const make = (px, to) => {
    const c = document.createElement('canvas');
    c.width = cols; c.height = rows;
    const ctx = c.getContext('2d'), img = ctx.createImageData(cols, rows);
    for (let r = 0; r < rows; r++) {
      const y = rows - 1 - r;
      for (let x = 0; x < cols; x++) {
        const v = Math.pow(px[r * cols + x] / 255, 1.25), o = (y * cols + x) * 4;
        img.data[o] = bg[0] + (to[0] - bg[0]) * v;
        img.data[o + 1] = bg[1] + (to[1] - bg[1]) * v;
        img.data[o + 2] = bg[2] + (to[2] - bg[2]) * v;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  };
  spec.imgs = { before: make(spec.before, fld), after: make(spec.after, fld), removed: make(spec.removed, sig) };
}

function drawCompare() {
  if (!spec || !spec.imgs) return;
  const cv = $('cmp-canvas'), mk = $('cmp-marks'), box = $('cmp');
  const dpr = Math.min(devicePixelRatio || 1, 2), w = box.clientWidth, h = box.clientHeight;
  for (const c of [cv, mk]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  const W = cv.width, H = cv.height;
  if (mode === 'removed') {
    ctx.drawImage(spec.imgs.removed, 0, 0, W, H);
  } else {
    const split = Math.round(($('cmp-range').value / 100) * W);
    ctx.drawImage(spec.imgs.before, 0, 0, W, H);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, split, H); ctx.clip();
    ctx.drawImage(spec.imgs.after, 0, 0, W, H);
    ctx.restore();
    $('cmp-handle').style.left = $('cmp-range').value + '%';
  }
  // marks: a translucent band along each removed tone, dashed centre line
  const m2 = mk.getContext('2d');
  m2.setTransform(dpr, 0, 0, dpr, 0, 0);
  m2.clearRect(0, 0, w, h);
  if (!$('mark').checked || mode === 'removed') return;
  const { duration, fmax, tracks } = spec.m, sig = css('--signal');
  const X = (t) => (t / duration) * w, Y = (f) => h * (1 - f / fmax);
  m2.lineCap = 'round'; m2.lineJoin = 'round'; m2.strokeStyle = sig;
  for (const tr of tracks) {
    if (!tr.pts || tr.pts.length < 2) continue;
    const path = () => { m2.beginPath(); tr.pts.forEach(([t, f], i) => (i ? m2.lineTo(X(t), Y(f)) : m2.moveTo(X(t), Y(f)))); };
    path(); m2.globalAlpha = 0.18; m2.lineWidth = 12; m2.setLineDash([]); m2.stroke();
    path(); m2.globalAlpha = 0.95; m2.lineWidth = 1.4; m2.setLineDash([4, 4]); m2.stroke();
  }
  m2.globalAlpha = 1; m2.setLineDash([]);
}

function drawAxis() {
  const ax = $('yaxis'), h = $('cmp').clientHeight, fmax = spec.m.fmax;
  ax.innerHTML = '';
  for (let i = 1; i <= 3; i++) {
    const hz = (fmax / 4) * i, s = document.createElement('span');
    s.style.top = `${h * (1 - hz / fmax)}px`;
    s.textContent = `${Math.round(hz)} Hz`;
    ax.appendChild(s);
  }
}

function setMode(m) {
  mode = m;
  $('v-compare').setAttribute('aria-pressed', String(m === 'compare'));
  $('v-removed').setAttribute('aria-pressed', String(m === 'removed'));
  $('cmp').classList.toggle('solo', m === 'removed');
  $('cmp-range').hidden = m === 'removed';
  drawCompare();
}
$('v-compare').onclick = () => setMode('compare');
$('v-removed').onclick = () => setMode('removed');
$('mark').onchange = drawCompare;
$('cmp-range').addEventListener('input', drawCompare);
{
  const box = $('cmp');
  let drag = false;
  const to = (e) => { const r = box.getBoundingClientRect(); $('cmp-range').value = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)); drawCompare(); };
  box.addEventListener('pointerdown', (e) => { if (mode !== 'compare') return; drag = true; box.setPointerCapture(e.pointerId); to(e); });
  box.addEventListener('pointermove', (e) => drag && to(e));
  box.addEventListener('pointerup', () => { drag = false; });
}
addEventListener('resize', () => { if (spec && !$('result').hidden) { drawCompare(); drawAxis(); } });
const retheme = () => { if (spec) { buildImages(); drawCompare(); } };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', retheme);
new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ------------------------------------------------------------------ inputs --
function homeError(msg) { $('home-error').textContent = msg; $('home-error').hidden = !msg; }
$('btn-pick').onclick = () => { homeError(''); engines(); $('file').click(); };
$('file').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) processMedia(f, f.name);
};
$('btn-again').onclick = () => show('home');
$('btn-back').onclick = () => show('home');
$('btn-share').onclick = async () => {
  const f = smallFile || outFile;   // share the smaller copy once there is one
  try { await navigator.share({ files: [f], title: f.name }); } catch {}
};

// camera
let stream = null, rec = null, chunks = [], facing = 'environment', tick = null;
const MIMES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

async function openCamera() {
  stopStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    show('home');
    homeError(`Camera or microphone not available: ${err.message}. Check the browser's permission for this site.`);
    return;
  }
  $('preview').srcObject = stream;
  show('camera');
}
function stopStream() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}
function resetRecUI() {
  $('btn-rec-toggle').classList.remove('on');
  $('btn-rec-toggle').setAttribute('aria-label', 'Start recording');
  $('timer').hidden = true;
  $('btn-flip').disabled = false;
}

$('btn-record').onclick = () => {
  homeError('');
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    homeError('This browser cannot record video here. Use "Choose a video" instead.');
    return;
  }
  engines();
  openCamera();
};
$('btn-flip').onclick = () => {
  if (rec && rec.state === 'recording') return;
  facing = facing === 'environment' ? 'user' : 'environment';
  openCamera();
};
$('btn-cam-cancel').onclick = () => {
  if (rec && rec.state === 'recording') { rec.onstop = null; rec.stop(); }
  clearInterval(tick);
  stopStream();
  resetRecUI();
  show('home');
};
$('btn-rec-toggle').onclick = () => {
  if (rec && rec.state === 'recording') { rec.stop(); return; }
  const mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : {});
  chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    clearInterval(tick);
    const type = rec.mimeType || mime || 'video/webm';
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type });
    chunks = [];
    stopStream();
    resetRecUI();
    processMedia(blob, 'recording.' + ext); // the raw clip only ever lives in memory
  };
  rec.start(1000);
  const t0 = Date.now();
  $('timer').hidden = false;
  $('btn-flip').disabled = true;
  $('btn-rec-toggle').classList.add('on');
  $('btn-rec-toggle').setAttribute('aria-label', 'Stop and clean');
  tick = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('timer-t').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 250);
};
