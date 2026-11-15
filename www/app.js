'use strict';
// Home dashboard front end. Plain JS, no libraries. Talks to server.py (/api/*).

const $ = (id) => document.getElementById(id);
const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/';
const POLL_SLOW = 10000, POLL_FAST = 2000, START_TIMEOUT = 180000;

let services = [];
let status = {};
let pending = {};          // id -> 'starting' | 'stopping'
let editMode = false;
let pollTimer = null;
let dlgWatch = null;       // function re-run after each status refresh while a dialog shows progress

// ---------- helpers ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
function svg(path) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = path;                      // constant markup only
  return s;
}
const ICONS = {
  power: '<path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};

async function api(method, path, body) {
  const opt = { method, headers: { 'X-Dashboard': '1' } };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  let j = {};
  try { j = await r.json(); } catch { /* not json */ }
  if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; e.data = j; throw e; }
  return j;
}

function iconSrc(s) {
  const i = (s.icon || '').trim();
  if (/^https?:\/\//i.test(i)) return i;
  if (i.includes('.')) return 'icons/' + i;
  if (i) return ICON_CDN + encodeURIComponent(i.toLowerCase()) + '.svg';
  try { return new URL(s.url).origin + '/favicon.ico'; } catch { return ''; }
}
function hue(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function iconBox(s) {
  const box = el('div', { class: 'ico' });
  const letter = () => {
    box.replaceChildren(el('span', { class: 'letter' }, (s.name || '?').trim().charAt(0).toUpperCase()));
    box.style.background = `hsl(${hue(s.name || '')} 55% 42%)`;
  };
  const src = iconSrc(s);
  if (!src) { letter(); return box; }
  const img = el('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', letter, { once: true });
  box.append(img);
  return box;
}

// What a tile should show for a service right now.
function view(s) {
  if (!s.managed) return { mode: 'open' };
  const st = status[s.id];
  const p = pending[s.id];
  if (p === 'stopping') return { dot: 'amber pulse', label: 'Stopping…', mode: 'busy' };
  if (!st) return { dot: '', label: '…', mode: 'open' };
  if (st.state === 'missing') return { dot: '', label: 'Not created yet', mode: 'missing', off: true };
  if (st.state === 'running') {
    if (!st.ready) return { dot: 'amber pulse', label: 'Starting…', mode: 'starting' };
    if (st.down && st.down.length) return { dot: 'amber', label: `Partly running (${st.down.length} stopped)`, mode: 'partial' };
    return { dot: 'green', label: 'Running', mode: 'open', running: true };
  }
  if (p === 'starting') return { dot: 'amber pulse', label: 'Starting…', mode: 'starting' };
  if (s.ondemand) return { dot: '', label: 'Off · tap to start', mode: 'start', off: true };
  return { dot: 'red', label: st.state === 'exited' || st.state === 'created' ? 'Stopped' : st.state, mode: 'start', off: true };
}

// ---------- rendering ----------
function render() {
  const groups = new Map();
  for (const s of services) {
    const g = s.group || 'Links';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }
  const main = $('groups');
  main.replaceChildren();
  for (const [name, items] of groups) {
    main.append(el('section', {}, el('h2', {}, name), el('div', { class: 'grid' }, items.map(tile))));
  }
  if (editMode) {
    main.append(el('section', {}, el('h2', {}, 'Add'), el('div', { class: 'grid' },
      el('button', { class: 'tile add-tile', type: 'button', onclick: addDialog }, svg(ICONS.plus), 'Add link'))));
  }
  renderSummary();
}

function tile(s) {
  const v = view(s);
  const a = el('a', {
    class: 'tile' + (v.off ? ' off' : ''), href: s.url, target: '_blank', rel: 'noopener',
    title: s.url,
    onclick: (e) => {
      if (editMode && s.custom) { e.preventDefault(); return removeDialog(s); }
      if (v.mode === 'open') return;          // normal link
      e.preventDefault();
      if (v.mode === 'start') startDialog(s);
      else if (v.mode === 'starting') progressDialog(s);
      else if (v.mode === 'partial') partialDialog(s);
      else if (v.mode === 'missing') missingDialog(s);
    },
  });
  const txt = el('div', { class: 'txt' },
    el('div', { class: 'name' }, s.name),
    s.description ? el('div', { class: 'desc' }, s.description) : null,
    v.label ? el('div', { class: 'state' }, el('span', { class: 'dot ' + (v.dot || '') }), v.label) : null);
  a.append(iconBox(s), txt);

  let btn = null;
  if (editMode && s.custom) {
    btn = el('button', { class: 'tile-btn stop', type: 'button', title: 'Remove this link', 'aria-label': `Remove ${s.name}`,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); removeDialog(s); } }, svg(ICONS.x));
  } else if (!editMode && s.managed && !s.nostop && (v.running || v.mode === 'starting' || v.mode === 'partial')) {
    btn = el('button', { class: 'tile-btn stop', type: 'button', title: `Stop ${s.name}`, 'aria-label': `Stop ${s.name}`,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); stopDialog(s); } }, svg(ICONS.power));
  } else if (!editMode && v.mode === 'start') {
    btn = el('button', { class: 'tile-btn', type: 'button', title: `Start ${s.name}`, 'aria-label': `Start ${s.name}`,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); startDialog(s); } }, svg(ICONS.play));
  }
  if (btn) { a.classList.add('has-btn'); a.append(btn); }
  return a;
}

function renderSummary() {
  const box = $('summary');
  const managed = services.filter((s) => s.managed && status[s.id]);
  if (!managed.length) { box.replaceChildren(); return; }
  let up = 0, off = 0, down = 0;
  for (const s of managed) {
    const v = view(s);
    if (v.running || v.mode === 'partial') up++;
    else if (v.mode === 'start' && s.ondemand) off++;
    else if (v.mode === 'start' || v.mode === 'missing') down++;
  }
  box.replaceChildren(...[
    el('span', { class: 'pill' }, el('span', { class: 'dot green' }), el('b', {}, String(up)), ' running'),
    off ? el('span', { class: 'pill' }, el('span', { class: 'dot' }), el('b', {}, String(off)), ' on demand, off') : null,
    down ? el('span', { class: 'pill' }, el('span', { class: 'dot red' }), el('b', {}, String(down)), ' stopped') : null,
  ].filter(Boolean));
}

function banner(msg) {
  const b = $('banner');
  b.hidden = !msg;
  b.textContent = msg || '';
}

// ---------- data ----------
async function loadServices() {
  const j = await api('GET', '/api/services');
  services = j.services || [];
  $('title').textContent = j.title || 'Home Lab';
  document.title = j.title || 'Home Lab';
  banner(j.configError);
  render();
}

async function refreshStatus() {
  clearTimeout(pollTimer);
  try {
    status = await api('GET', '/api/status');
    if (!$('banner').textContent.startsWith('services.json')) banner('');
    $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    for (const id of Object.keys(pending)) {        // clear finished actions
      const st = status[id];
      if (pending[id] === 'starting' && st && st.state === 'running' && st.ready) delete pending[id];
      if (pending[id] === 'stopping' && st && st.state !== 'running') delete pending[id];
    }
  } catch (e) {
    banner(e.status ? e.message : 'The dashboard server is not answering. Is Docker running?');
  }
  render();
  if (dlgWatch) dlgWatch();
  const busy = Object.keys(pending).length || services.some((s) => view(s).mode === 'starting');
  if (document.visibilityState === 'visible') pollTimer = setTimeout(refreshStatus, busy ? POLL_FAST : POLL_SLOW);
}

// ---------- dialogs ----------
const dlg = $('dlg');
dlg.addEventListener('close', () => { dlgWatch = null; });

function showDialog(s, title, body, actions) {
  const icon = $('dlgIcon');
  if (s) { icon.src = iconSrc(s); icon.hidden = false; icon.onerror = () => { icon.hidden = true; }; } else icon.hidden = true;
  $('dlgTitle').textContent = title;
  $('dlgBody').replaceChildren(...[body].flat().filter(Boolean));
  $('dlgActions').replaceChildren(...actions.filter(Boolean));
  if (!dlg.open) dlg.showModal();
}
const btn = (label, cls, onclick, type = 'button') => el('button', { class: 'btn ' + (cls || ''), type, onclick }, label);
const closeBtn = (label = 'Close') => btn(label, '', () => dlg.close());
const openBtn = (s) => el('a', { class: 'btn primary', href: s.url, target: '_blank', rel: 'noopener', onclick: () => dlg.close() }, `Open ${s.name}`);
const spinner = (text) => el('div', { class: 'progress' }, el('span', { class: 'spinner' }), text);

function startDialog(s) {
  const st = status[s.id] || {};
  const intro = s.ondemand ? `${s.name} is off right now. Start it?`
    : `${s.name} is stopped (${st.status || 'not running'}). It normally runs all the time. Start it again?`;
  showDialog(s, `Start ${s.name}?`,
    [el('p', {}, intro), s.warn ? el('p', { class: 'note' }, s.warn) : null],
    [closeBtn('Cancel'), btn('Start', 'primary', () => doStart(s))]);
}

async function doStart(s) {
  pending[s.id] = 'starting';
  progressDialog(s);
  render();
  try {
    await api('POST', `/api/start/${s.id}`, {});
  } catch (e) {
    delete pending[s.id];
    render();
    return showDialog(s, `Couldn't start ${s.name}`, el('p', { class: 'err' }, e.message), [closeBtn()]);
  }
  refreshStatus();
}

function progressDialog(s) {
  const t0 = Date.now();
  const tick = () => {
    const v = view(s);
    if (v.running || v.mode === 'partial') {
      dlgWatch = null;
      return showDialog(s, `${s.name} is ready`, el('p', {}, `${s.name} is running.`), [closeBtn(), openBtn(s)]);
    }
    if (Date.now() - t0 > START_TIMEOUT) {
      dlgWatch = null;
      return showDialog(s, `${s.name} is slow to start`,
        el('p', {}, `It has been running for a while but isn't answering yet. You can try opening it anyway, or check it with "docker logs ${s.container}" in Ubuntu.`),
        [closeBtn(), openBtn(s)]);
    }
    showDialog(s, `Starting ${s.name}…`,
      [spinner(`Waiting for ${s.name} to answer. This usually takes a few seconds.`), s.warn ? el('p', { class: 'note' }, s.warn) : null],
      [closeBtn('Hide')]);
  };
  dlgWatch = tick;
  tick();
}

function partialDialog(s) {
  const st = status[s.id] || {};
  showDialog(s, `${s.name} is partly running`,
    el('p', {}, `These parts are stopped: ${(st.down || []).join(', ')}. ${s.name} may not work properly until they run.`),
    [closeBtn(), el('a', { class: 'btn', href: s.url, target: '_blank', rel: 'noopener', onclick: () => dlg.close() }, 'Open anyway'),
      btn('Start the rest', 'primary', () => doStart(s))]);
}

function missingDialog(s) {
  showDialog(s, `${s.name} isn't set up`,
    el('p', {}, `There is no container called "${s.container}" yet. Create it once from Ubuntu with "docker compose up -d" in its stack folder; after that the dashboard can start and stop it.`),
    [closeBtn()]);
}

function stopDialog(s) {
  const intro = s.ondemand
    ? `${s.name} will stop and free its memory. You can start it again from here any time.`
    : `${s.name} normally runs all the time. It will stay off, even after a restart of the PC, until you start it again here.`;
  showDialog(s, `Stop ${s.name}?`,
    [el('p', {}, intro), s.stopWarn ? el('p', { class: 'note' }, s.stopWarn) : null],
    [closeBtn('Cancel'), btn('Stop', 'danger', () => doStop(s, false))]);
}

async function doStop(s, force) {
  showDialog(s, `Stopping ${s.name}…`, spinner('Stopping… (databases get up to 30 s to shut down cleanly)'), []);
  try {
    await api('POST', `/api/stop/${s.id}`, { force });
  } catch (e) {
    if (e.status === 409) {
      return showDialog(s, `${s.name} is busy`, el('p', { class: 'note' }, e.message),
        [closeBtn('Keep running'), btn('Stop anyway', 'danger', () => doStop(s, true))]);
    }
    if (!e.status || ((e.status === 502 || e.status === 504) && !(e.data && e.data.error))) {
      // The connection itself went away: expected when the proxy carrying this page was just stopped.
      return showDialog(s, 'Connection lost',
        el('p', {}, `The page lost its connection while stopping ${s.name}. If you stopped Proxy Manager, that's expected: ` +
          'start it again on the PC at http://localhost:8088.'), [closeBtn()]);
    }
    return showDialog(s, `Couldn't stop ${s.name}`, el('p', { class: 'err' }, e.message), [closeBtn()]);
  }
  pending[s.id] = 'stopping';
  dlg.close();
  refreshStatus();
}

function addDialog() {
  const groups = [...new Set(services.map((s) => s.group || 'Links'))];
  const f = {
    name: el('input', { name: 'name', required: true, maxlength: 60, placeholder: 'Portainer', autocomplete: 'off' }),
    url: el('input', { name: 'url', type: 'url', required: true, placeholder: 'https://portainer.example.com', autocomplete: 'off' }),
    group: el('input', { name: 'group', list: 'groupList', placeholder: groups[0] || 'Links', autocomplete: 'off' }),
    icon: el('input', { name: 'icon', placeholder: 'portainer', autocomplete: 'off', autocapitalize: 'none' }),
    description: el('input', { name: 'description', maxlength: 120, placeholder: 'What it is (optional)', autocomplete: 'off' }),
  };
  const err = el('p', { class: 'err' });
  showDialog(null, 'Add a link', [
    el('label', {}, 'Name', f.name),
    el('label', {}, 'Address', f.url),
    el('label', {}, 'Section ', el('small', {}, '(pick one or type a new one)'), f.group),
    el('datalist', { id: 'groupList' }, groups.map((g) => el('option', { value: g }))),
    el('label', {}, 'Icon ', el('small', {}, '(optional: a name from dashboard-icons.dev, or an image URL)'), f.icon),
    el('label', {}, 'Description', f.description),
    err,
  ], [closeBtn('Cancel'), btn('Add', 'primary', async () => {
    if (!f.name.value.trim() || !f.url.value.trim()) { err.textContent = 'Name and address are needed.'; return; }
    try {
      await api('POST', '/api/links', Object.fromEntries(Object.entries(f).map(([k, i]) => [k, i.value])));
      dlg.close();
      await loadServices();
    } catch (e) { err.textContent = e.message; }
  })]);
  f.name.focus();
}

function removeDialog(s) {
  showDialog(s, `Remove ${s.name}?`, el('p', {}, `The link to ${s.url} will be removed from the dashboard. Nothing else changes.`),
    [closeBtn('Cancel'), btn('Remove', 'danger', async () => {
      try { await api('DELETE', `/api/links/${s.id}`); dlg.close(); await loadServices(); }
      catch (e) { showDialog(s, "Couldn't remove it", el('p', { class: 'err' }, e.message), [closeBtn()]); }
    })]);
}

// ---------- clock, edit mode, start-up ----------
function clock() {
  const d = new Date(), h = d.getHours();
  $('time').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('date').textContent = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  $('hello').textContent = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

$('editBtn').addEventListener('click', () => {
  editMode = !editMode;
  $('editBtn').setAttribute('aria-pressed', String(editMode));
  $('editBtn').querySelector('span').textContent = editMode ? 'Done' : 'Edit';
  render();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { clock(); loadServices().catch(() => {}); refreshStatus(); }
  else clearTimeout(pollTimer);
});

clock();
setInterval(clock, 15000);
loadServices().catch((e) => banner(e.status ? e.message : 'The dashboard server is not answering.')).finally(refreshStatus);
