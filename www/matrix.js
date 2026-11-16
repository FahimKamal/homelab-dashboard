'use strict';
// Animated "digital rain" background. Plain canvas 2D, no libraries; app.js knows nothing about it.
// Settings are kept per browser (localStorage) and changed in the "Background" panel (bottom of this file).
//
// How it works: the screen is a grid of glyph cells. Each column has one falling "drop"; every cell it
// passes lights up (brightness 1) and then fades, which draws the trail. The colour of each column comes
// from the chosen colours, blended into a slow wave that drifts across the screen. Near the pointer the
// glyphs are pushed outwards and lit up, moving the pointer leaves a light trail, and a click/tap sends a ripple.

(() => {
  const KEY = 'dashboard.background';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const FRAME_MS = 1000 / (coarse ? 30 : 60);          // phones: 30 fps is plenty and saves battery
  const MAX_COLORS = 6;
  const DEFAULTS = {
    on: !reduceMotion, mouse: true,
    speed: 1, density: 1, bright: 0.7, size: 16, shift: 1,
    colors: ['#22ff88', '#22d3ee', '#818cf8'],
  };
  const GLYPHS = Array.from('ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789ZXCVBNM<>*+=-:.¦');
  const FONT = '"MS Gothic", "Noto Sans Mono CJK JP", "Noto Sans JP", "Hiragino Sans", monospace';

  // ---------- settings ----------
  const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  function clean(s) {
    s = s && typeof s === 'object' ? s : {};
    const colors = Array.isArray(s.colors)
      ? s.colors.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)).slice(0, MAX_COLORS) : [];
    return {
      on: typeof s.on === 'boolean' ? s.on : DEFAULTS.on,
      mouse: typeof s.mouse === 'boolean' ? s.mouse : DEFAULTS.mouse,
      speed: num(s.speed, 0.2, 3, DEFAULTS.speed),
      density: num(s.density, 0.2, 3, DEFAULTS.density),
      bright: num(s.bright, 0.15, 1, DEFAULTS.bright),
      size: Math.round(num(s.size, 10, 28, DEFAULTS.size)),
      shift: num(s.shift, 0, 3, DEFAULTS.shift),
      colors: colors.length ? colors : DEFAULTS.colors.slice(),
    };
  }
  function load() {
    try { return clean(JSON.parse(localStorage.getItem(KEY))); } catch { return clean({}); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* private mode / storage blocked */ }
  }

  // ---------- colour helpers ----------
  const WHITE = [255, 255, 255];
  const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  const css = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  function paletteAt(p) {                      // p = position in "colour steps"; wraps around the list
    const n = pal.length;
    if (n === 1) return pal[0];
    p = ((p % n) + n) % n;
    const i = Math.floor(p), f = p - i;
    return mix(pal[i], pal[(i + 1) % n], f * f * (3 - 2 * f));
  }

  // ---------- state ----------
  const canvas = document.getElementById('matrix');
  const ctx = canvas.getContext('2d');
  let cfg = load();
  let pal = [];
  let W = 0, H = 0, dpr = 1, fs = 16, cols = 0, rows = 0;
  let bright, glyph, cellFade, isHead;              // per cell
  let dropC, dropY, dropV, dropL, dropH, nd = 0;    // per drop: column, y (cells), speed, trail length, head row
  let raf = 0, lastT = 0, resizeTimer = 0;
  const LIGHT_FADE = 0.9;                           // fade per second of cells lit by the pointer
  const P = { x: -1e4, y: -1e4, px: 0, py: 0, moved: false, inside: false, isMouse: true, touchUntil: 0, inf: 0 };
  const ripples = [];

  const rnd = (a, b) => a + Math.random() * (b - a);
  const rg = () => (Math.random() * GLYPHS.length) | 0;

  function newDrop(k, anywhere) {
    // Whole multiples of the column count get one drop per column each; the rest land in random columns.
    const full = Math.floor(nd / cols) * cols;
    dropC[k] = k < full ? k % cols : (Math.random() * cols) | 0;
    dropV[k] = rnd(7, 20);                    // cells per second at speed 1
    dropL[k] = rnd(8, 30);                    // trail length in cells
    dropY[k] = anywhere ? rnd(-rows, rows) : rnd(-rows * 0.6, 0);
    dropH[k] = Math.floor(dropY[k]);
  }

  function unmarkHead(k) {
    const h = dropH[k];
    if (h >= 0 && h < rows) isHead[h * cols + dropC[k]] = 0;
  }

  // Size the drop list to the intensity setting, keeping the drops that are already falling.
  function setDrops() {
    const n = Math.max(1, Math.round(cols * cfg.density)), keep = Math.min(n, nd);
    for (let k = keep; k < nd; k++) unmarkHead(k);
    const grow = (old) => { const a = new Float32Array(n); if (old) a.set(old.subarray(0, keep)); return a; };
    const oldC = dropC, oldH = dropH;
    dropY = grow(dropY); dropV = grow(dropV); dropL = grow(dropL);
    dropC = new Int32Array(n); dropH = new Int32Array(n);
    if (oldC) { dropC.set(oldC.subarray(0, keep)); dropH.set(oldH.subarray(0, keep)); }
    nd = n;
    for (let k = keep; k < n; k++) newDrop(k, true);
  }

  function setSize() {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // resizing a canvas resets its state
    ctx.font = `${fs}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  function build() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    fs = cfg.size;
    cols = Math.ceil(W / fs);
    rows = Math.ceil(H / fs) + 1;
    const n = cols * rows;
    bright = new Float32Array(n);
    glyph = new Uint8Array(n);
    for (let i = 0; i < n; i++) glyph[i] = rg();
    cellFade = new Float32Array(n);
    isHead = new Uint8Array(n);
    dropC = dropY = dropV = dropL = dropH = null; nd = 0;
    setDrops();
    setSize();
    for (let k = 0; k < 40; k++) step(0.05, 0);   // start with rain already on screen
  }

  function onResize() {
    // Phones resize the height when the address bar slides in/out: keep the rain if the grid still fits.
    if (window.innerWidth === W && Math.ceil(window.innerHeight / fs) + 1 <= rows) {
      H = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      setSize();
      return;
    }
    build();
  }

  // ---------- simulation ----------
  function light(x, y, rad, amt) {            // light up the cells in a disc around (x, y)
    const c0 = Math.max(0, Math.floor((x - rad) / fs)), c1 = Math.min(cols - 1, Math.floor((x + rad) / fs));
    const r0 = Math.max(0, Math.floor((y - rad) / fs)), r1 = Math.min(rows - 1, Math.floor((y + rad) / fs));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(c * fs + fs / 2 - x, r * fs + fs / 2 - y);
        if (d >= rad) continue;
        const v = amt * (1 - d / rad), i = r * cols + c;
        if (v > bright[i]) { bright[i] = v; cellFade[i] = LIGHT_FADE; if (Math.random() < 0.5) glyph[i] = rg(); }
      }
    }
  }

  function ring(x, y, rad, w, amt) {          // light up a ring (click ripple)
    const out = rad + w;
    const c0 = Math.max(0, Math.floor((x - out) / fs)), c1 = Math.min(cols - 1, Math.floor((x + out) / fs));
    const r0 = Math.max(0, Math.floor((y - out) / fs)), r1 = Math.min(rows - 1, Math.floor((y + out) / fs));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const off = Math.abs(Math.hypot(c * fs + fs / 2 - x, r * fs + fs / 2 - y) - rad);
        if (off >= w) continue;
        const v = amt * (1 - off / w), i = r * cols + c;
        if (v > bright[i]) { bright[i] = v; cellFade[i] = LIGHT_FADE; glyph[i] = rg(); }
      }
    }
  }

  function step(dt, now) {
    const sp = cfg.speed;
    for (let k = 0; k < nd; k++) {
      const c = dropC[k];
      dropY[k] += dropV[k] * sp * dt;
      const r = Math.floor(dropY[k]);
      if (r !== dropH[k]) {
        unmarkHead(k);
        const f = dropV[k] / dropL[k];                     // fade per second, so the trail is dropL cells long
        for (let j = dropH[k] + 1; j <= r; j++) {          // every cell the drop entered this frame
          if (j >= 0 && j < rows) { const i = j * cols + c; bright[i] = 1; cellFade[i] = f; glyph[i] = rg(); }
        }
        dropH[k] = r;
        if (r >= 0 && r < rows) isHead[r * cols + c] = 1;
      }
      if (dropY[k] - dropL[k] > rows) { unmarkHead(k); newDrop(k, false); }
    }
    for (let i = 0, n = cols * rows; i < n; i++) {
      if (bright[i] > 0) { const b = bright[i] - cellFade[i] * sp * dt; bright[i] = b > 0 ? b : 0; }
    }
    const flips = (cols * rows * 0.6 * dt) | 0;          // glyphs keep changing a little
    for (let k = 0; k < flips; k++) glyph[(Math.random() * cols * rows) | 0] = rg();

    if (!now || !cfg.mouse) return;
    if (P.moved) {                                         // light trail along the pointer's path
      const d = Math.hypot(P.x - P.px, P.y - P.py), n = Math.min(24, Math.ceil(d / fs));
      for (let k = 1; k <= n; k++) light(P.px + (P.x - P.px) * k / n, P.py + (P.y - P.py) * k / n, fs * 2.2, 0.85);
      P.px = P.x; P.py = P.y; P.moved = false;
    }
    for (let k = ripples.length - 1; k >= 0; k--) {
      const age = (now - ripples[k].t) / 1000;
      if (age > 1.1) { ripples.splice(k, 1); continue; }
      ring(ripples[k].x, ripples[k].y, age * 520, fs * 1.6, 0.9 * (1 - age / 1.1));
    }
  }

  // ---------- drawing ----------
  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    const t = cfg.shift * 0.12 * now / 1000;              // colour steps per second
    const R = Math.max(110, fs * 8), R2 = R * R, inf = P.inf, useM = inf > 0.01;
    const mx = P.x, my = P.y, am = cfg.bright;
    for (let c = 0; c < cols; c++) {
      const col = paletteAt(t + c / cols);                 // the whole width spans one colour step
      const colS = css(col), headS = css(mix(col, WHITE, 0.75));
      const x0 = c * fs + fs / 2, dx = x0 - mx, near = useM && Math.abs(dx) < R;
      let cur = colS;
      ctx.fillStyle = colS;
      for (let r = 0, i = c; r < rows; r++, i += cols) {
        const hd = isHead[i] === 1;
        let b = bright[i], x = x0, y = r * fs + fs / 2, style = hd ? headS : colS;
        if (near) {
          const dy = y - my, d2 = dx * dx + dy * dy;
          if (d2 < R2) {                                   // bubble around the pointer
            const d = Math.sqrt(d2) || 1, f = 1 - d / R, f2 = f * f * inf, push = f2 * R * 0.35;
            x += (dx / d) * push; y += (dy / d) * push;     // push outwards (never crosses over, so no tearing)
            b = Math.min(1, Math.max(b, 0.45 * f * inf) + 0.7 * f2);
            if (f2 > 0.03) style = css(mix(col, WHITE, Math.min(0.85, f2 * 1.3)));
          }
        }
        if (b < 0.03) continue;
        if (style !== cur) { ctx.fillStyle = style; cur = style; }
        ctx.globalAlpha = hd ? Math.min(1, b * am + 0.25) : b * am;
        ctx.fillText(GLYPHS[glyph[i]], x, y);
      }
    }
    ctx.globalAlpha = 1;
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - lastT < FRAME_MS * 0.8) return;
    const dt = Math.min(0.1, (now - lastT) / 1000);       // a hidden tab pauses; don't jump afterwards
    lastT = now;
    const want = cfg.mouse && (P.isMouse ? P.inside : now < P.touchUntil) ? 1 : 0;
    P.inf += (want - P.inf) * Math.min(1, dt * 5);
    step(dt, now);
    draw(now);
  }

  function start() {
    if (raf) return;
    document.body.classList.add('matrix-on');
    canvas.hidden = false;
    build();
    lastT = performance.now();
    raf = requestAnimationFrame(loop);
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    canvas.hidden = true;
    document.body.classList.remove('matrix-on');
    bright = null;                                         // free the grid
  }

  // Apply cfg to the running animation. what: 'grid' = glyph size changed, 'drops' = intensity changed.
  function apply(what) {
    pal = cfg.colors.map(hex2rgb);
    if (!cfg.on) stop();
    else if (!raf) start();
    else if (what === 'grid') build();
    else if (what === 'drops') setDrops();
    save();
  }

  // ---------- pointer ----------
  function track(e) {
    if (P.x < -1000) { P.px = e.clientX; P.py = e.clientY; }   // first move after entering: no streak
    P.x = e.clientX; P.y = e.clientY; P.moved = true; P.inside = true;
    P.isMouse = e.pointerType === 'mouse';
    if (!P.isMouse) P.touchUntil = performance.now() + 1200;
  }
  window.addEventListener('pointermove', track, { passive: true });
  window.addEventListener('pointerdown', (e) => {
    track(e);
    if (!raf || !cfg.mouse) return;
    ripples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (ripples.length > 4) ripples.shift();
  }, { passive: true });
  window.addEventListener('pointerout', (e) => { if (!e.relatedTarget) { P.inside = false; P.x = P.y = -1e4; } });
  window.addEventListener('blur', () => { P.inside = false; });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (raf) onResize(); }, 150);
  });

  // ---------- settings panel ----------
  const PRESETS = [
    ['Green', ['#00ff66', '#00b347']],
    ['Home Lab', ['#818cf8', '#ec4899', '#14b8a6']],
    ['Ocean', ['#22d3ee', '#3b82f6', '#a78bfa']],
    ['Sunset', ['#facc15', '#f97316', '#f43f5e']],
    ['Rainbow', ['#f43f5e', '#facc15', '#22c55e', '#22d3ee', '#a855f7']],
    ['Ice', ['#ffffff', '#7dd3fc']],
  ];
  const RANGES = [                             // [input id, setting, how to show the value, what apply() redoes]
    ['bgSpeed', 'speed', (v) => v.toFixed(1) + '×', false],
    ['bgDensity', 'density', (v) => Math.round(v * 100) + '%', 'drops'],
    ['bgBright', 'bright', (v) => Math.round(v * 100) + '%', false],
    ['bgSize', 'size', (v) => v + ' px', 'grid'],
    ['bgShift', 'shift', (v) => (v === 0 ? 'Still' : v.toFixed(1) + '×'), false],
  ];
  const $ = (id) => document.getElementById(id);
  const panel = $('bgPanel'), openBtn = $('bgBtn');
  function mk(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    e.append(...kids);
    return e;
  }
  function randomColor() {                     // a bright colour with a random hue
    const h = Math.random() * 360, s = 0.9, l = 0.6, a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
    };
    return '#' + f(0) + f(8) + f(4);
  }

  function renderColors() {
    const box = $('bgColors');
    box.replaceChildren();
    cfg.colors.forEach((c, k) => {
      const inp = mk('input', { type: 'color', value: c, 'aria-label': `Color ${k + 1}`, title: 'Change this color' });
      // 'input' fires while the picker is open: update live, but don't re-render (that would close the picker)
      inp.addEventListener('input', () => { cfg.colors[k] = inp.value.toLowerCase(); apply(false); markPreset(); });
      const sw = mk('div', { class: 'sw' }, inp);
      if (cfg.colors.length > 1) {
        const x = mk('button', { type: 'button', class: 'sw-x', title: 'Remove this color', 'aria-label': `Remove color ${k + 1}` }, '×');
        x.addEventListener('click', () => { cfg.colors.splice(k, 1); changed(false); });
        sw.append(x);
      }
      box.append(sw);
    });
    if (cfg.colors.length < MAX_COLORS) {
      const add = mk('button', { type: 'button', class: 'sw-add', title: 'Add a color', 'aria-label': 'Add a color' }, '+');
      add.addEventListener('click', () => { cfg.colors.push(randomColor()); changed(false); });
      box.append(add);
    }
  }

  function renderPresets() {
    $('bgPresets').replaceChildren(...PRESETS.map(([name, colors]) => {
      const chip = mk('i');
      chip.style.background = colors.length > 1 ? `linear-gradient(90deg, ${colors.join(', ')})` : colors[0];
      const b = mk('button', { type: 'button', class: 'preset', 'aria-pressed': 'false', 'data-colors': colors.join() }, chip, name);
      b.addEventListener('click', () => { cfg.colors = colors.slice(); changed(false); });
      return b;
    }));
  }
  function markPreset() {
    const now = cfg.colors.join();
    for (const b of $('bgPresets').children) b.setAttribute('aria-pressed', String(b.dataset.colors === now));
  }

  function syncPanel() {                       // settings → controls
    $('bgOn').checked = cfg.on;
    $('bgMouse').checked = cfg.mouse;
    $('bgOpts').disabled = !cfg.on;
    for (const [id, key, fmt] of RANGES) { $(id).value = cfg[key]; $(id + 'V').textContent = fmt(cfg[key]); }
    renderColors();
    markPreset();
  }
  function changed(rebuild) { apply(rebuild); syncPanel(); }

  function showPanel(open) {
    panel.hidden = !open;
    openBtn.setAttribute('aria-expanded', String(open));
    if (open) { syncPanel(); $('bgOn').focus(); }
  }

  for (const [id, key, fmt, what] of RANGES) {
    $(id).addEventListener('input', (e) => {
      cfg[key] = Number(e.target.value);
      $(id + 'V').textContent = fmt(cfg[key]);
      apply(what);
    });
  }
  $('bgOn').addEventListener('change', (e) => { cfg.on = e.target.checked; changed(false); });
  $('bgMouse').addEventListener('change', (e) => { cfg.mouse = e.target.checked; changed(false); });
  $('bgReset').addEventListener('click', () => { cfg = Object.assign(clean({}), { on: cfg.on }); changed('grid'); });
  openBtn.addEventListener('click', () => showPanel(panel.hidden));
  $('bgClose').addEventListener('click', () => { showPanel(false); openBtn.focus(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden && !document.querySelector('dialog[open]')) { showPanel(false); openBtn.focus(); }
  });
  document.addEventListener('pointerdown', (e) => {            // click anywhere else closes it
    if (!panel.hidden && !panel.contains(e.target) && !openBtn.contains(e.target)) showPanel(false);
  });

  renderPresets();
  apply(false);
})();
