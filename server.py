#!/usr/bin/env python3
"""Home dashboard: serves www/ and a tiny JSON API backed by the Docker socket.

Only containers named in config/services.json can be read, started or stopped
(entries with "nostop": true can't be stopped). Standard library only.
"""
import http.client
import json
import os
import re
import socket
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WWW = '/app/www'
CONFIG = '/config/services.json'
SOCK = '/var/run/docker.sock'
PORT = int(os.environ.get('PORT', '8080'))
DOMAIN = os.environ.get('DASHBOARD_DOMAIN', '').strip()   # fills "{domain}" in tile URLs (set in .env)
STATUS_CACHE_S = 2.5          # several devices polling at once share one Docker query

TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
         '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
         '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
         '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
         '.webmanifest': 'application/manifest+json'}
CSP = ("default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")


def log(msg):
    print(time.strftime('%Y-%m-%d %H:%M:%S'), msg, flush=True)


# ---------- Docker API over the unix socket ----------
class _DockerConn(http.client.HTTPConnection):
    def __init__(self, timeout):
        super().__init__('localhost', timeout=timeout)

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(SOCK)
        self.sock = s


def docker(method, path, timeout=10, body=None):
    c = _DockerConn(timeout)
    try:
        if body is None:
            c.request(method, path)
        else:
            c.request(method, path, json.dumps(body), {'Content-Type': 'application/json'})
        r = c.getresponse()
        body = r.read()
        if body and (r.getheader('Content-Type') or '').startswith('application/json'):
            try:
                body = json.loads(body)
            except ValueError:                  # streamed answers (image pull) are many JSON lines: keep raw
                pass
        return r.status, body
    finally:
        c.close()


def all_containers():
    code, data = docker('GET', '/containers/json?all=1')
    if code != 200:
        raise RuntimeError(f'Docker API answered {code}')
    return data


def cname(c):
    return c['Names'][0].lstrip('/')


def stack_members(main, conts):
    """All containers of the main container's compose project (main last)."""
    proj = (main.get('Labels') or {}).get('com.docker.compose.project')
    others = [c for c in conts if proj and c is not main
              and (c.get('Labels') or {}).get('com.docker.compose.project') == proj]
    return sorted(others, key=cname) + [main]


# ---------- config ----------
_cfg_lock = threading.Lock()
_cfg = {'mtime': None, 'data': {'title': 'Home Lab', 'services': []}, 'error': None}


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') or 'item'


def load_config():
    """Re-read services.json whenever it changes. A broken file keeps the last good one + an error."""
    with _cfg_lock:
        try:
            mtime = os.stat(CONFIG).st_mtime_ns
            if mtime != _cfg['mtime']:
                with open(CONFIG, encoding='utf-8') as f:
                    data = json.load(f)
                seen = set()
                for s in data.get('services', []):
                    sid = s.get('id') or slug(s.get('name', ''))
                    while sid in seen:
                        sid += '-2'
                    seen.add(sid)
                    s['id'] = sid
                _cfg.update(mtime=mtime, data=data, error=None)
                log(f'config loaded: {len(data.get("services", []))} entries')
        except json.JSONDecodeError as e:
            _cfg['error'] = f'services.json has an error at line {e.lineno}, column {e.colno}: {e.msg}'
            _cfg['mtime'] = mtime
            log(_cfg['error'])
        except OSError as e:
            _cfg['error'] = f'cannot read services.json: {e}'
        return _cfg['data'], _cfg['error']


def save_config(data):
    out = dict(data)
    out['services'] = [{k: v for k, v in s.items() if k != 'id'} for s in data['services']]
    tmp = CONFIG + '.tmp'
    old = os.umask(0o002)                       # stays editable for fahim (group 1000)
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
            f.write('\n')
        os.replace(tmp, CONFIG)
    finally:
        os.umask(old)
        _cfg['mtime'] = None                    # always re-read the file (ids come from names)


def find_service(sid):
    data, _ = load_config()
    return next((s for s in data.get('services', []) if s['id'] == sid), None)


# ---------- status ----------
_status_lock = threading.Lock()
_status_cache = {'t': 0, 'data': None}
_pool = ThreadPoolExecutor(max_workers=8)


def probe(url, timeout=2.5):
    """True if the app answers HTTP at all (any status below 500)."""
    u = urllib.parse.urlsplit(url)
    c = (http.client.HTTPSConnection if u.scheme == 'https' else http.client.HTTPConnection)(
        u.hostname, u.port, timeout=timeout)
    try:
        c.request('GET', (u.path or '/') + (('?' + u.query) if u.query else ''),
                  headers={'User-Agent': 'home-dashboard'})
        return c.getresponse().status < 500
    except Exception:
        return False
    finally:
        c.close()


def compute_status():
    data, _ = load_config()
    conts = all_containers()
    by_name = {cname(c).lower(): c for c in conts}
    out, checks = {}, {}
    for s in data.get('services', []):
        name = s.get('container')
        if not name:
            continue
        c = by_name.get(name.lower())
        if not c:
            out[s['id']] = {'state': 'missing'}
            continue
        members = stack_members(c, conts)
        info = {'state': c['State'], 'status': c.get('Status', ''),
                'down': [cname(m) for m in members if m['State'] != 'running']}
        st = info['status']
        info['health'] = ('unhealthy' if '(unhealthy)' in st else 'starting' if '(health: starting)' in st
                          else 'healthy' if '(healthy)' in st else None)
        if c['State'] == 'running':
            info['ready'] = info['health'] not in ('starting', 'unhealthy')
            if s.get('check'):
                checks[s['id']] = s['check']
        out[s['id']] = info
    for sid, ok in zip(checks, _pool.map(probe, checks.values())):
        out[sid]['ready'] = ok and out[sid]['health'] != 'unhealthy'
    return out


def get_status():
    with _status_lock:
        if time.time() - _status_cache['t'] > STATUS_CACHE_S or _status_cache['data'] is None:
            _status_cache['data'] = compute_status()
            _status_cache['t'] = time.time()
        return _status_cache['data']


def busy_count(s):
    """Running+queued jobs for apps that report them (8mblocal). None = can't tell."""
    b = s.get('busy')
    if not b:
        return None
    u = urllib.parse.urlsplit(b['url'])
    c = http.client.HTTPConnection(u.hostname, u.port, timeout=4)
    try:
        c.request('GET', u.path or '/')
        r = c.getresponse()
        j = json.loads(r.read())
        return sum(int(j.get(f) or 0) for f in b.get('fields', []))
    except Exception:
        return None
    finally:
        c.close()


# ---------- "update": true → Start = docker compose pull + up -d ----------
# Recreating a container from a new image can't be done safely with plain API calls (the old image's built-in
# settings would be copied onto the new one), so a short-lived helper container runs the real compose CLI in
# the stack's folder, exactly like `docker compose pull && docker compose up -d` from the shell.
UPDATER_IMAGE = os.environ.get('UPDATER_IMAGE', 'docker:29.10.0-cli')
_updating = set()
_upd_lock = threading.Lock()


def _pull_image(ref):
    repo, _, tag = ref.rpartition(':')
    code, body = docker('POST', f'/images/create?fromImage={urllib.parse.quote(repo)}&tag={urllib.parse.quote(tag)}',
                        timeout=600)
    if code != 200 or b'"error' in (body if isinstance(body, bytes) else json.dumps(body).encode()):
        raise RuntimeError(f'pulling {ref} failed: {code}')


def _run_update(s, main):
    labels = main.get('Labels') or {}
    proj = labels['com.docker.compose.project']
    wd = labels['com.docker.compose.project.working_dir']
    files = labels['com.docker.compose.project.config_files'].split(',')
    name = f'dashboard-update-{slug(proj)}'
    args = ['--ansi', 'never', '--progress', 'plain', '-p', proj] + [a for f in files for a in ('-f', f)]
    # Values go in as "$@" (no shell parsing of them). A failed pull (offline) still starts the image already there.
    script = ('docker compose "$@" pull -q || echo "update check failed: starting the version already here"; '
              'exec docker compose "$@" up -d')
    ok = False
    try:
        docker('DELETE', f'/containers/{name}?force=1')               # leftover from an interrupted run
        code, _ = docker('GET', f'/images/{urllib.parse.quote(UPDATER_IMAGE, safe="")}/json')
        if code == 404:
            _pull_image(UPDATER_IMAGE)
        spec = {
            'Image': UPDATER_IMAGE, 'Cmd': ['sh', '-c', script, 'sh'] + args, 'WorkingDir': wd, 'Tty': True,
            'Labels': {'home-dashboard.helper': 'update'},
            'HostConfig': {
                'Binds': [f'{wd}:{wd}:ro', '/var/run/docker.sock:/var/run/docker.sock'],
                'NetworkMode': 'none',          # it only talks to the socket; the engine does the downloading
                'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges:true'],
                'Memory': 256 * 1024 * 1024, 'PidsLimit': 64,
            },
        }
        code, body = docker('POST', f'/containers/create?name={name}', body=spec)
        if code != 201:
            raise RuntimeError(f'creating the helper failed: {code} {body}')
        cid = body['Id']
        log(f'update {proj}: pulling + recreating (helper {name})')
        code, _ = docker('POST', f'/containers/{cid}/start')
        if code not in (204, 304):
            raise RuntimeError(f'starting the helper failed: {code}')
        code, res = docker('POST', f'/containers/{cid}/wait', timeout=900)
        _, out = docker('GET', f'/containers/{cid}/logs?stdout=1&stderr=1&tail=20')
        text = out.decode('utf-8', 'replace') if isinstance(out, bytes) else str(out)
        for line in text.replace('\r', '\n').splitlines():
            if line.strip():
                log(f'update {proj}: {line.strip()}')
        ok = code == 200 and isinstance(res, dict) and res.get('StatusCode') == 0
        docker('DELETE', f'/containers/{cid}?force=1')
    except Exception as e:                                              # noqa: BLE001 (never let the thread die silently)
        log(f'update {proj}: {e}')
    finally:
        with _upd_lock:
            _updating.discard(proj)
    if not ok:
        log(f'update {proj}: failed, starting the existing containers instead')
        try:
            act(s, 'start', update=False)
        except Exception as e:                                          # noqa: BLE001
            log(f'update {proj}: plain start failed too: {e}')
    _status_cache['t'] = 0


def start_with_update(s, main):
    labels = main.get('Labels') or {}
    need = ('com.docker.compose.project', 'com.docker.compose.project.working_dir',
            'com.docker.compose.project.config_files')
    if not all(labels.get(k) for k in need):
        return None                                                     # not a compose container: plain start
    wd = labels['com.docker.compose.project.working_dir'].rstrip('/') + '/'
    if not all(f.startswith(wd) for f in labels['com.docker.compose.project.config_files'].split(',')):
        return None                                                     # compose file outside the folder we mount
    proj = labels['com.docker.compose.project']
    with _upd_lock:
        if proj in _updating:
            return 200, {'ok': True, 'updating': True}
        _updating.add(proj)
    threading.Thread(target=_run_update, args=(s, main), daemon=True).start()
    return 200, {'ok': True, 'updating': True}


def act(s, action, force=False, update=True):
    conts = all_containers()
    main = next((c for c in conts if cname(c).lower() == s['container'].lower()), None)
    if not main:
        return 404, {'error': f"Container '{s['container']}' doesn't exist yet. "
                              f"Create it once from Ubuntu with: docker compose up -d (in its stack folder)."}
    members = stack_members(main, conts)
    if action == 'start' and update and s.get('update'):
        r = start_with_update(s, main)
        if r:
            return r
    if action == 'start':
        # dependencies (databases, redis) first, the app itself last
        for m in members:
            if m['State'] != 'running':
                code, body = docker('POST', f"/containers/{m['Id']}/start", timeout=60)
                if code not in (204, 304):
                    msg = body.get('message') if isinstance(body, dict) else body
                    return 500, {'error': f'{cname(m)}: {msg}'}
                log(f'started {cname(m)}')
                if m is not main:
                    time.sleep(1)
    else:
        if not force:
            n = busy_count(s)
            if n:
                return 409, {'busy': n, 'error': f"{s['name']} has {n} job(s) running or queued. "
                                                 f"Stopping now cancels them."}
        for m in reversed(members):             # the app first, then its dependencies
            if m['State'] == 'running':
                code, body = docker('POST', f"/containers/{m['Id']}/stop?t=30", timeout=60)
                if code not in (204, 304):
                    msg = body.get('message') if isinstance(body, dict) else body
                    return 500, {'error': f'{cname(m)}: {msg}'}
                log(f'stopped {cname(m)}')
    _status_cache['t'] = 0
    return 200, {'ok': True}


# ---------- links added from the page ----------
def clean_link(j):
    name = str(j.get('name', '')).strip()[:60]
    url = str(j.get('url', '')).strip()[:500]
    if not name:
        raise ValueError('Give the link a name.')
    if not re.match(r'^https?://[^\s]+$', url, re.I):
        raise ValueError('The address must start with http:// or https://')
    link = {'name': name, 'url': url,
            'group': str(j.get('group', '')).strip()[:40] or 'Links',
            'description': str(j.get('description', '')).strip()[:120],
            'icon': str(j.get('icon', '')).strip()[:300]}
    if link['icon'] and not re.match(r'^(https?://\S+|[A-Za-z0-9._-]+)$', link['icon']):
        raise ValueError('Icon: use a name like "portainer", a file in icons/, or an image URL.')
    return {k: v for k, v in link.items() if v}


# ---------- HTTP ----------
class Handler(BaseHTTPRequestHandler):
    server_version = 'home-dashboard'
    sys_version = ''

    def log_message(self, fmt, *args):      # no per-request access log (keeps `docker logs` tiny)
        pass

    def send(self, code, body, ctype='application/json', cache='no-store'):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', CSP)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 10000:
            raise ValueError('too big')
        return json.loads(self.rfile.read(n) or b'{}')

    def guard(self):
        # A custom header can't be sent cross-site without a CORS preflight, which we never allow.
        if self.headers.get('X-Dashboard') != '1':
            self.send(403, {'error': 'forbidden'})
            return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == '/api/services':
                data, err = load_config()
                pub = ('id', 'name', 'url', 'icon', 'group', 'description', 'ondemand', 'custom', 'warn',
                       'container', 'stopWarn', 'nostop', 'update')
                items = [dict({k: s[k] for k in pub if k in s}, managed=bool(s.get('container')))
                         for s in data.get('services', [])]
                for it in items:
                    it['url'] = str(it.get('url', '')).replace('{domain}', DOMAIN)
                return self.send(200, {'title': data.get('title', 'Home Lab'), 'services': items,
                                       'configError': err})
            if path == '/api/status':
                return self.send(200, get_status())
            if path == '/api/ping':
                return self.send(200, {'ok': True})
            return self.static(path)
        except (OSError, RuntimeError) as e:
            log(f'GET {path}: {e}')
            return self.send(502, {'error': 'Docker is not reachable from the dashboard: ' + str(e)})

    def static(self, path):
        if path == '/':
            path = '/index.html'
        full = os.path.realpath(os.path.join(WWW, path.lstrip('/')))
        if not full.startswith(WWW + os.sep) or not os.path.isfile(full):
            return self.send(404, b'not found', 'text/plain')
        ext = os.path.splitext(full)[1].lower()
        with open(full, 'rb') as f:
            body = f.read()
        cache = 'public, max-age=86400' if '/icons/' in path else 'no-cache'
        return self.send(200, body, TYPES.get(ext, 'application/octet-stream'), cache)

    def do_POST(self):
        if not self.guard():
            return
        path = urllib.parse.urlsplit(self.path).path
        try:
            m = re.fullmatch(r'/api/(start|stop)/([a-z0-9-]+)', path)
            if m:
                action, sid = m.groups()
                s = find_service(sid)
                if not s or not s.get('container'):
                    return self.send(404, {'error': 'unknown service'})
                if action == 'stop' and s.get('nostop'):
                    return self.send(403, {'error': f"{s['name']} is marked \"nostop\" in services.json; "
                                                    f"it can't be stopped from the dashboard."})
                force = bool(self.read_json().get('force'))
                log(f'{action} {sid} requested by {self.headers.get("X-Real-IP") or self.client_address[0]}')
                return self.send(*act(s, action, force))
            if path == '/api/links':
                link = clean_link(self.read_json())
                data, err = load_config()
                if err:
                    return self.send(409, {'error': err + ' (fix it first)'})
                link['custom'] = True
                save_config(dict(data, services=data['services'] + [link]))
                log(f"link added: {link['name']} -> {link['url']}")
                return self.send(200, {'ok': True})
            return self.send(404, {'error': 'not found'})
        except ValueError as e:
            return self.send(400, {'error': str(e)})
        except (OSError, RuntimeError) as e:
            log(f'POST {path}: {e}')
            return self.send(502, {'error': str(e)})

    def do_DELETE(self):
        if not self.guard():
            return
        m = re.fullmatch(r'/api/links/([a-z0-9-]+)', urllib.parse.urlsplit(self.path).path)
        if not m:
            return self.send(404, {'error': 'not found'})
        data, err = load_config()
        s = next((s for s in data['services'] if s['id'] == m.group(1)), None)
        if not s or not s.get('custom'):
            return self.send(403, {'error': 'Only links added from this page can be removed here.'})
        save_config(dict(data, services=[x for x in data['services'] if x is not s]))
        log(f"link removed: {s['name']}")
        return self.send(200, {'ok': True})


if __name__ == '__main__':
    load_config()
    ThreadingHTTPServer.daemon_threads = True
    log(f'listening on :{PORT}')
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
