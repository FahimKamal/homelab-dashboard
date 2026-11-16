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
    speed: 1, bright: 0.7, size: 16, shift: 1,
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
  let bright, glyph, dropY, dropV, dropL, fade, head;
  let raf = 0, lastT = 0, resizeTimer = 0;
  const P = { x: -1e4, y: -1e4, px: 0, py: 0, moved: false, inside: false, isMouse: true, touchUntil: 0, inf: 0 };
  const ripples = [];

  const rnd = (a, b) => a + Math.random() * (b - a);
  const rg = () => (Math.random() * GLYPHS.length) | 0;

  function newDrop(c, anywhere) {
    dropV[c] = rnd(7, 20);                    // cells per second at speed 1
    dropL[c] = rnd(8, 30);                    // trail length in cells
    fade[c] = dropV[c] / dropL[c];            // brightness lost per second, so the trail is dropL cells long
    dropY[c] = anywhere ? rnd(-rows, rows) : rnd(-rows * 0.6, 0);
    head[c] = Math.floor(dropY[c]);
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
    dropY = new Float32Array(cols); dropV = new Float32Array(cols); dropL = new Float32Array(cols);
    fade = new Float32Array(cols); head = new Int32Array(cols);
    for (let c = 0; c < cols; c++) newDrop(c, true);
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
        if (v > bright[i]) { bright[i] = v; if (Math.random() < 0.5) glyph[i] = rg(); }
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
        if (v > bright[i]) { bright[i] = v; glyph[i] = rg(); }
      }
    }
  }

  function step(dt, now) {
    const sp = cfg.speed;
    for (let c = 0; c < cols; c++) {
      dropY[c] += dropV[c] * sp * dt;
      const r = Math.floor(dropY[c]);
      for (let k = head[c] + 1; k <= r; k++) {           // every cell the drop entered this frame
        if (k >= 0 && k < rows) { const i = k * cols + c; bright[i] = 1; glyph[i] = rg(); }
      }
      head[c] = r;
      if (dropY[c] - dropL[c] > rows) newDrop(c, false);
    }
    for (let r = 0, i = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, i++) {
        if (bright[i] > 0) { const b = bright[i] - fade[c] * sp * dt; bright[i] = b > 0 ? b : 0; }
      }
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
      const x0 = c * fs + fs / 2, dx = x0 - mx, near = useM && Math.abs(dx) < R, hr = head[c];
      let cur = colS;
      ctx.fillStyle = colS;
      for (let r = 0, i = c; r < rows; r++, i += cols) {
        let b = bright[i], x = x0, y = r * fs + fs / 2, style = r === hr ? headS : colS;
        if (near) {
          const dy = y - my, d2 = dx * dx + dy * dy;
          if (d2 < R2) {                                   // bubble around the pointer
            const d = Math.sqrt(d2) || 1, f = 1 - d / R, f2 = f * f * inf, push = f2 * R * 0.35;
            x += (dx / d) * push; y += (dy / d) * push;     // push outwards (never crosses over, so no tearing)
            b = Math.min(1, Math.max(b, 0.3 * f * inf) + 0.5 * f2);
            if (f2 > 0.04) style = css(mix(col, WHITE, Math.min(0.85, f2)));
          }
        }
        if (b < 0.03) continue;
        if (style !== cur) { ctx.fillStyle = style; cur = style; }
        ctx.globalAlpha = r === hr ? Math.min(1, b * am + 0.25) : b * am;
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

  // Apply cfg to the running animation. rebuild = the grid size changed.
  function apply(rebuild) {
    pal = cfg.colors.map(hex2rgb);
    if (!cfg.on) stop();
    else if (!raf) start();
    else if (rebuild) build();
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

  apply(false);
})();
