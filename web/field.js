// Doppler Scrub field: a live particle spectrogram. Aircraft tones (signal colour) slide in
// from the right and come apart as they cross the scrub line. Ported from design/prototype.html.
(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const isDark = () => {
    const t = document.documentElement.getAttribute('data-theme');
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const C = 343;
  const FMAX = 600;          // Hz shown along the depth axis

  // ------------------------------------------------------------------ field --
  const stage = $('stage'), canvas = $('field');
  let gl3 = null;
  try { gl3 = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' }); } catch (e) {}
  if (!gl3 || typeof THREE === 'undefined') {
    stage.insertAdjacentHTML('beforeend', '<div class="fallback">This browser can\'t draw the live field.</div>');
  }

  const phone = innerWidth < 700;
  if (!$('stage')) return;
  const compact = $('stage').dataset.compact === '1';
  const WIN = phone || compact ? 16 : 24;                 // seconds across the field
  const COLS = phone ? 150 : compact ? 220 : 270, ROWS = phone ? 84 : compact ? 90 : 140;
  const W = phone ? 6.4 : 9, D = phone ? 3.6 : 4.4;
  const SCRUB = 0.34;                          // where the scrub line sits, 0..1 from the left
  const TRAIL = 24;

  const planes = [];       // {t0, f0, v, d, jet, n}
  let passNo = 0;
  function spawn(t0) {
    const jet = Math.random() < 0.3;
    planes.push({
      t0, jet, n: ++passNo,
      f0: jet ? 150 + Math.random() * 40 : 78 + Math.random() * 40,
      v: jet ? 105 + Math.random() * 30 : 62 + Math.random() * 22,
      d: jet ? 650 + Math.random() * 400 : 280 + Math.random() * 280,
    });
  }
  const recv = (p, t) => {
    const x = p.v * (t - p.t0), r = Math.hypot(x, p.d);
    return { ratio: C / (C + p.v * x / r), amp: p.d / r };
  };

  let scene, camera, points, mat, raycaster, ground;
  const trail = typeof THREE === 'undefined' ? [] : Array.from({ length: TRAIL }, () => new THREE.Vector4(0, 0, -99, 0));
  let trailIdx = 0;

  const VERT = `
    attribute vec2 aGrid;
    attribute float aRand;
    uniform float uNow, uWin, uScrub, uFmax, uSize, uPx, uW, uD;
    uniform vec4 uPlanes[3];
    uniform vec4 uTrail[${TRAIL}];
    uniform vec3 uField, uSig, uHead;
    varying vec3 vCol;
    varying float vA;
    vec3 m3(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 m4(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 pm(vec4 x){return m4(((x*34.0)+1.0)*x);}
    float sn(vec3 v){
      const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
      vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
      vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m3(i);
      vec4 p=pm(pm(pm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
      float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.0*floor(p*ns.z*ns.z);
      vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;
      vec4 h=1.0-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
      vec4 nr=1.79284291400159-0.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));
      p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;
      vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
      return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }
    void main(){
      float u = aGrid.x, v = aGrid.y;
      float tc = uNow - (1.0 - u) * uWin;          // the moment this column was recorded
      float fHz = v * uFmax;

      // noise floor: slow weather plus fine grain, louder at low frequencies
      float n1 = sn(vec3(v * 4.0, tc * 0.22, 0.0)) * 0.5 + 0.5;
      float n2 = sn(vec3(v * 36.0, tc * 2.4, aRand * 4.0)) * 0.5 + 0.5;
      float floorH = (0.08 + 0.26 * n1 * n1) * (1.0 - 0.5 * v) * (0.55 + 0.45 * n2);
      floorH += 0.28 * exp(-v * 16.0) * (0.6 + 0.4 * n1);

      // aircraft: blade-pass tone and harmonics, Doppler-shifted
      float tone = 0.0;
      for (int i = 0; i < 3; i++) {
        vec4 p = uPlanes[i];
        if (p.z <= 0.0) continue;
        float x = p.z * (tc - p.x);
        float r = sqrt(x * x + p.w * p.w);
        float ratio = 343.0 / (343.0 + p.z * x / r);
        float amp = p.w / r;
        amp *= smoothstep(0.1, 0.3, amp);
        for (int k = 1; k <= 4; k++) {
          float fk = p.y * float(k) * ratio;
          float d = (fHz - fk) / (2.4 + 0.004 * fk);
          tone += amp * exp(-d * d) / pow(float(k), 0.55);
        }
      }
      tone = min(tone, 1.3);

      // the scrub line: columns left of it have passed through
      float age = (uScrub - u) * uWin;             // seconds since this column was scrubbed
      float done = step(0.0, age);
      float fly = clamp(age / 1.6, 0.0, 1.0);
      float live = tone * (1.0 - done);
      float dust = tone * done * (1.0 - fly);      // removed tone points lift away and fade

      vec3 pos = vec3((u - 0.5) * uW, 0.0, (0.5 - v) * uD);
      float y = floorH * 0.6 + live * 0.95;
      y += dust * (0.95 + fly * (1.4 + 2.6 * aRand));
      pos.x -= dust * fly * 0.9 * (aRand - 0.25);

      // the visitor's own wavefronts: rings bunch up ahead of a moving pointer
      float rip = 0.0;
      for (int i = 0; i < ${TRAIL}; i++) {
        vec4 tr = uTrail[i];
        if (tr.w <= 0.0) continue;
        float a = uNow - tr.z;
        if (a < 0.0 || a > 2.6) continue;
        float dd = length(pos.xz - tr.xy) - a * 1.7;
        rip += exp(-dd * dd * 70.0) * exp(-a * 1.5) * tr.w;
      }
      y += rip * 0.2;
      pos.y = y;

      vec4 mv = modelViewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mv;

      float lev = clamp(floorH * 2.4, 0.0, 1.0);
      float sig = smoothstep(0.22, 0.7, live) + smoothstep(0.22, 0.7, dust);
      float head = 1.0 - smoothstep(0.0, 0.0045, abs(u - uScrub));
      gl_PointSize = uSize * uPx * (0.65 + 0.55 * aRand + sig * 1.3 + rip * 0.9 + head * 0.6) / -mv.z;

      vec3 base = uField * (0.32 + 0.68 * lev);
      vCol = mix(base, uSig, sig);
      vCol = mix(vCol, uHead, head * 0.85);
      vCol += uField * rip * 0.5;
      vA = max(0.28 + 0.62 * lev, sig);
      vA = max(vA, head * 0.9);
      vA *= mix(1.0, 1.0 - fly, step(0.02, dust));
      vA *= mix(1.0, 0.45, v);                                   // high frequencies recede
      vA *= smoothstep(0.0, 0.05, u) * smoothstep(1.0, 0.95, u); // soft left and right edges
    }`;
  const FRAG = `
    varying vec3 vCol;
    varying float vA;
    void main(){
      vec2 c = gl_PointCoord - 0.5;
      float d = dot(c, c);
      if (d > 0.25) discard;
      gl_FragColor = vec4(vCol, vA * smoothstep(0.25, 0.04, d));
    }`;

  const hex = (h) => new THREE.Color(h);
  function applyTheme() {
    if (!mat) return;
    mat.uniforms.uField.value = hex(css('--field'));
    mat.uniforms.uSig.value = hex(css('--signal'));
    mat.uniforms.uHead.value = hex(css('--head'));
    mat.blending = isDark() ? THREE.AdditiveBlending : THREE.NormalBlending;
    mat.needsUpdate = true;
  }

  function initField() {
    if (!gl3) return;
    gl3.setPixelRatio(Math.min(devicePixelRatio, 2));
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    const n = COLS * ROWS;
    const grid = new Float32Array(n * 2), rnd = new Float32Array(n), pos = new Float32Array(n * 3);
    let k = 0;
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++, k++) {
      grid[k * 2] = (c + Math.random() * 0.6) / (COLS - 1);
      grid[k * 2 + 1] = (r + Math.random() * 0.6) / (ROWS - 1);
      rnd[k] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aGrid', new THREE.BufferAttribute(grid, 2));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: false,
      uniforms: {
        uNow: { value: 0 }, uWin: { value: WIN }, uScrub: { value: SCRUB }, uFmax: { value: FMAX },
        uSize: { value: phone ? 15 : 17 }, uPx: { value: gl3.getPixelRatio() }, uW: { value: W }, uD: { value: D },
        uPlanes: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uTrail: { value: trail },
        uField: { value: hex('#888') }, uSig: { value: hex('#f0f') }, uHead: { value: hex('#fff') },
      },
    });
    points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);
    raycaster = new THREE.Raycaster();
    ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    applyTheme();
    resize();
    addEventListener('resize', resize);
    stage.addEventListener('pointermove', onPointer);
    stage.addEventListener('pointerdown', (e) => onPointer(e, true));
  }

  function resize() {
    if (!gl3) return;
    const w = stage.clientWidth, h = stage.clientHeight;
    gl3.setSize(w, h, false);
    camera.aspect = w / h;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    const dist = Math.max(compact ? 3.2 : 5.6, (W * (compact ? 0.42 : 0.5) * 1.04) / (half * camera.aspect));
    camera.position.set(0, dist * 0.52, dist * 0.92);
    camera.lookAt(0, 0.15, -0.35);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    placeTags();
  }

  const tagAt = (id, x, y, z) => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    const el = $(id);
    if (!el) return;
    let left = ((p.x + 1) / 2) * stage.clientWidth;
    if (el.classList.contains('hz')) left = Math.min(left, stage.clientWidth - 64);   // keep frequency labels on screen
    el.style.left = left + 'px';
    el.style.top = ((1 - p.y) / 2) * stage.clientHeight + 'px';
  };
  function placeTags() {
    const xs = (SCRUB - 0.5) * W, zf = (0.5 - 1.02) * D, zn = 0.5 * D;
    tagAt('tag-head', xs, 0.3, zf - 0.1);
    tagAt('tag-past', -W * 0.36, 0, zn - 0.15);
    tagAt('tag-now', W * 0.38, 0, zn - 0.15);
    for (const hz of [100, 300, 500]) tagAt('tag-' + hz, W * 0.5, 0.05, (0.5 - hz / FMAX) * D);
  }

  let lastTrail = 0, lastPt = null;
  function onPointer(e, tap) {
    if (!camera) return;
    const r = stage.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(ground, hit)) return;
    if (Math.abs(hit.x) > W * 0.55 || Math.abs(hit.z) > D * 0.7) return;
    const now = clock();
    const moved = lastPt ? Math.hypot(hit.x - lastPt.x, hit.z - lastPt.z) : 1;
    if (tap || (now - lastTrail > 0.06 && moved > 0.04)) {
      trail[trailIdx].set(hit.x, hit.z, now, tap ? 1.4 : 1);
      trailIdx = (trailIdx + 1) % TRAIL;
      lastTrail = now; lastPt = hit.clone();
    }
  }

  // ---------------------------------------------------------------- timing --
  const t0wall = performance.now();
  const clock = () => (reduce ? 40 : (performance.now() - t0wall) / 1000 + 40);
  // complete at rest: one pass already crossing the scrub line, one coming in
  spawn(clock() - WIN * 0.5);
  spawn(clock() + 9);
  let nextSpawn = clock() + 15;

  function tickPlanes(now) {
    if (now > nextSpawn) { spawn(now + 8 + Math.random() * 3); nextSpawn = now + 13 + Math.random() * 7; }
    while (planes.length > 3) planes.shift();
    for (let i = 0; i < 3; i++) {
      const p = planes[i];
      mat && mat.uniforms.uPlanes.value[i].set(p ? p.t0 : 0, p ? p.f0 : 0, p ? p.v : 0, p ? p.d : 1);
    }
  }

  // --------------------------------------------------------------- readout --
  const fmtT = (s) => { s = Math.abs(Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  let lastRead = 0;
  function readout(now) {
    if (!$('r-pass') || now - lastRead < 0.12) return;
    lastRead = now;
    let best = null, bestAmp = 0;
    for (const p of planes) { const { amp } = recv(p, now); if (amp > bestAmp) { bestAmp = amp; best = p; } }
    if (!best) return;
    const { ratio } = recv(best, now), dt = now - best.t0;
    $('r-pass').textContent = String(best.n).padStart(2, '0');
    $('r-type').textContent = best.jet ? 'Regional jet' : 'Turboprop';
    $('r-f0').textContent = `${best.f0.toFixed(0)} Hz`;
    $('r-f').textContent = `${(best.f0 * ratio).toFixed(1)} Hz`;
    $('r-kt').textContent = `${Math.round(best.v * 1.944)} kt`;
    $('r-cpa').textContent = dt < 0 ? `in ${fmtT(dt)}` : `${fmtT(dt)} ago`;
  }

  // ----------------------------------------------------------------- sound --
  let ac = null, toneGain, ambGain, oscs = [], mode = 'off';
  function ensureAudio() {
    if (ac) return;
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const master = ac.createGain(); master.gain.value = 0.9; master.connect(ac.destination);
    const len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    let b = 0; for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 3; }
    const noise = ac.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
    ambGain = ac.createGain(); ambGain.gain.value = 0;
    noise.connect(lp).connect(ambGain).connect(master); noise.start();
    toneGain = ac.createGain(); toneGain.gain.value = 0;
    const tlp = ac.createBiquadFilter(); tlp.type = 'lowpass'; tlp.frequency.value = 900;
    toneGain.connect(tlp).connect(master);
    for (let k = 1; k <= 4; k++) {
      const o = ac.createOscillator(); o.type = k === 1 ? 'sawtooth' : 'triangle';
      const g = ac.createGain(); g.gain.value = 0.22 / k;
      o.connect(g).connect(toneGain); o.start(); oscs.push(o);
    }
  }
  function setMode(m) {
    mode = m;
    for (const [id, v] of [['snd-off', 'off'], ['snd-raw', 'raw'], ['snd-clean', 'clean']]) $(id)?.setAttribute('aria-pressed', String(m === v));
    if (m !== 'off') { ensureAudio(); ac.resume(); }
    if (ac) ambGain.gain.setTargetAtTime(m === 'off' ? 0 : 0.16, ac.currentTime, 0.1);
  }
  if ($('snd-off')) {
    $('snd-off').onclick = () => setMode('off');
    $('snd-raw').onclick = () => setMode('raw');
    $('snd-clean').onclick = () => setMode('clean');
  }
  function sound(now) {
    if (!ac || mode === 'off') { if (ac) toneGain.gain.setTargetAtTime(0, ac.currentTime, 0.1); return; }
    let amp = 0, f = 100;
    for (const p of planes) { const r = recv(p, now); if (r.amp > amp) { amp = r.amp; f = p.f0 * r.ratio; } }
    oscs.forEach((o, i) => o.frequency.setTargetAtTime(f * (i + 1), ac.currentTime, 0.05));
    toneGain.gain.setTargetAtTime(mode === 'raw' ? Math.min(amp, 1) * 0.35 : 0, ac.currentTime, 0.08);
  }

  // ----------------------------------------------------------------- theme --
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ------------------------------------------------------------------ loop --
  initField();
  addEventListener('ds:layout', () => requestAnimationFrame(resize));
  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; }).observe(stage);
  function frame() {
    const now = clock();
    tickPlanes(now);
    if (mat) { mat.uniforms.uNow.value = now; if (visible) gl3.render(scene, camera); }
    readout(now);
    sound(now);
    if (!reduce) requestAnimationFrame(frame);
  }
  frame();
})();
