/**
 * dsh-pku-cluster — PKU clusters for DeepSeek Harness.
 *
 * Two independent choices, both in the page bars:
 *
 *   execution target - where the plugin runs ssh: a WSL distribution on Windows,
 *                      the host itself on Linux/macOS.
 *   session          - cluster × endpoint, e.g. `wm1:login` or `wm2:data`.
 *
 * Every session owns its own ControlMaster socket, so several clusters can stay
 * logged in at the same time; nothing is torn down when you switch. On Windows
 * the WSL path needs a relay per session (the VPN only reaches the Windows
 * stack), and those relays are allocated on demand.
 *
 * Credentials never touch disk: the password and OTP travel over stdin to a pty
 * driver and are discarded once ssh has answered its prompts.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';

import * as clusters from './clusters.js';
import * as targetList from './targets.js';

export const name = 'pku-cluster';
export const inject = ['webServer'];

const ROUTE_BASE = '/plugins/dsh-pku-cluster';
const IS_WINDOWS = process.platform === 'win32';

const DEFAULTS = {
  loginHost: '',        // '' -> the built-in catalogue (clusters.json)
  loginPort: 22,
  relayPort: 0,         // >0: try this port first (one session); 0: OS picks per session
  distro: '',           // '' -> WSL's default distribution
  autoInstall: true,    // write helper scripts into the target
};

/** Shown when Windows has no WSL distribution at all — there is nothing to use. */
const NO_TARGET_HINT =
  'Windows 上没有可用的 WSL 发行版：请先安装或启动一个（wsl --install），再打开此面板。';

/* ------------------------------------------------------------------ */
/* bash plumbing (WSL distributions and POSIX hosts)                   */
/* ------------------------------------------------------------------ */

function bashInvocation(distro, command) {
  if (!IS_WINDOWS) return ['bash', ['-lc', command]];
  return distro
    ? ['wsl.exe', ['-d', distro, '-e', 'bash', '-lc', command]]
    : ['wsl.exe', ['-e', 'bash', '-lc', command]];
}

function runBash(distro, command, { stdin = '', timeoutMs = 45_000 } = {}) {
  const [file, args] = bashInvocation(distro, command);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({ error: `cannot spawn ${file}: ${error.message}` });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ error: e.message }));
    child.on('close', (code) => finish({ code, out, err }));
    child.stdin.end(stdin);
  });
}

function parsePayload(result) {
  if (!result || result.error) return { ok: false, error: result?.error ?? 'unknown failure' };
  const lines = String(result.out ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  const detail = String(result.err || result.out || '').trim().split(/\r?\n/).slice(-3).join(' | ');
  return { ok: false, error: `helper returned no JSON (exit ${result.code})${detail ? `: ${detail}` : ''}` };
}

/* ------------------------------------------------------------------ */
/* helper scripts (bash targets)                                       */
/* ------------------------------------------------------------------ */

/**
 * Scripts are copied byte-for-byte into the target. A Windows checkout with
 * core.autocrlf=true has CRLF in the working tree, and a CRLF shebang makes
 * bash answer `env: 'bash\r': No such file or directory` (exit 127), so the
 * line endings are normalised here rather than trusted from git.
 */
function assetTextLf(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

const ASSETS = [
  { path: 'login.py', mode: '700', text: () => assetTextLf('../resources/login.py') },
  { path: 'pku', mode: '700', text: () => assetTextLf('../resources/pku') },
];

/** One spawn writes every session file, so a poll never costs seven of them. */
const WRITE_SESSIONS_PY = String.raw`
import base64, json, os, re, sys
payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
base = os.path.expanduser(os.path.join("~", ".pku-cluster", "sessions"))
os.makedirs(base, exist_ok=True)
legacy = {}
try:
    legacy = json.load(open(os.path.expanduser("~/.pku-cluster/config.json")))
except Exception:
    legacy = {}
for s in payload:
    name = re.sub(r"[^0-9A-Za-z._-]+", "-", s["key"].replace(":", "-")) + ".json"
    path = os.path.join(base, name)
    try:
        old = json.load(open(path))
    except Exception:
        old = {}
    user = s.get("user") or old.get("user", "")
    # First run after the upgrade: the account id still lives in the 0.2
    # config.json, so inherit it instead of asking for it again.
    if not user and legacy.get("loginHost") == s.get("host"):
        user = legacy.get("user", "")
    # One account normally serves every cluster, so prefill from the old config.
    s["user"] = user or str(legacy.get("user") or "")
    # Never lose the login stamp: the remaining time is computed from it.
    s["connectedAt"] = int(s.get("connectedAt") or old.get("connectedAt") or 0)
    with open(path, "w") as fh:
        fh.write(json.dumps(s, indent=2) + "\n")
`;

async function installAssets(distro) {
  for (const asset of ASSETS) {
    const cmd = `mkdir -p "$HOME/.pku-cluster" && cat > "$HOME/.pku-cluster/${asset.path}" && chmod ${asset.mode} "$HOME/.pku-cluster/${asset.path}"`;
    const r = await runBash(distro, cmd, { stdin: asset.text(), timeoutMs: 30_000 });
    if (r.error || r.code !== 0) {
      return { ok: false, error: `failed to install ${asset.path}: ${r.error ?? r.err ?? ''}`.trim() };
    }
  }
  return { ok: true };
}

/**
 * The script travels on stdin (heredoc) and the payload in argv as base64:
 * `python3 -c "<code>"` would hand bash the `\n` of JSON.stringify literally.
 */
async function writeSessionsBash(distro, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const r = await runBash(distro, `python3 - ${encoded} <<'PKU_PY'\n${WRITE_SESSIONS_PY}\nPKU_PY`, {
    timeoutMs: 30_000,
  });
  if (r.error || r.code !== 0) {
    return { ok: false, error: (r.error ?? r.err ?? 'cannot write session files').trim() };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* relay pool (Windows only, one listener per WSL session)             */
/* ------------------------------------------------------------------ */

const relays = new Map(); // session key -> { server, port, address, host }

function wslHostAddress() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!/wsl|vEthernet/i.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) return addr.address;
    }
  }
  return null;
}

const relayHostFor = (session) => session.relayHost || session.host || '';

/**
 * Create (or reuse) the listener that forwards <Windows address>:port to this
 * endpoint.
 *
 * WSL reaches Windows two ways. With NAT networking the relay must listen on
 * the vEthernet address WSL sees as its gateway. With `networkingMode=mirrored`
 * there is no vEthernet at all, but WSL can reach Windows' loopback directly,
 * so the relay binds 127.0.0.1 and the session dials that instead of a gateway.
 *
 * Resolves to { port, address }; address is '' when no relay could be created.
 */
function ensureRelay(session, preferredPort = 0) {
  const existing = relays.get(session.key);
  if (existing && existing.server.listening && existing.host === relayHostFor(session)) {
    return Promise.resolve({ port: existing.port, address: existing.address });
  }
  if (existing) {
    try { existing.server.close(); } catch { /* ignore */ }
    relays.delete(session.key);
  }
  return new Promise((resolve) => {
    if (!IS_WINDOWS) { resolve({ port: 0, address: '' }); return; }
    const address = wslHostAddress() ?? '127.0.0.1';
    const upstream = { host: relayHostFor(session), port: Number(session.port) || 22, family: 4 };
    const server = net.createServer((client) => {
      const target = net.connect(upstream, () => {
        client.pipe(target);
        target.pipe(client);
      });
      const destroy = () => { client.destroy(); target.destroy(); };
      client.on('error', destroy);
      target.on('error', destroy);
      client.on('close', () => target.destroy());
      target.on('close', () => client.destroy());
    });
    // An explicitly configured relayPort is honoured for the first session
    // that needs one (people do pin firewall rules); every later session falls
    // back to an ephemeral port, because two listeners cannot share one.
    let retried = false;
    server.on('error', () => {
      if (!retried && preferredPort) {
        retried = true;
        server.listen(0, address);
        return;
      }
      resolve({ port: 0, address: '' });
    });
    server.listen(preferredPort || 0, address, () => {
      const port = server.address().port;
      relays.set(session.key, { server, port, address, host: relayHostFor(session) });
      resolve({ port, address });
    });
  });
}

function relayStatus(key) {
  const entry = relays.get(key);
  return {
    mode: entry ? 'relay' : 'direct',
    listening: Boolean(entry?.server?.listening),
    address: entry?.address ?? null,
    port: entry?.port ?? null,
  };
}

function closeRelays() {
  for (const entry of relays.values()) {
    try { entry.server.close(); } catch { /* ignore */ }
  }
  relays.clear();
}

/* ------------------------------------------------------------------ */
/* sessions                                                            */
/* ------------------------------------------------------------------ */

const catalog = (settings) => clusters.listSessions(settings);

/** In-memory session view for the given execution target (no writes). */
function sessionView(entry, target) {
  const stored = clusters.readSession(entry.key) ?? {};
  const mode = target?.kind === 'wsl' ? 'relay' : 'direct';
  return {
    key: entry.key,
    cluster: entry.cluster,
    clusterLabel: entry.clusterLabel,
    endpoint: entry.endpoint,
    endpointLabel: entry.endpointLabel,
    label: entry.label,
    host: entry.host,
    port: Number(entry.port) || Number(stored.port) || 22,
    user: typeof stored.user === 'string' ? stored.user : '',
    mode,
    relayHost: '',
    relayPort: Number(stored.relayPort) || 0,
    controlPath: clusters.controlPathFor(target, entry.key),
    target: target?.kind === 'wsl' ? `wsl:${target.distro}` : 'local',
  };
}

/**
 * Re-point every session at this execution target: the mode (relay/direct) and
 * the control socket live in the session file, because the python driver and
 * `pku` read them from there.
 */
async function syncSessions(target, settings) {
  const views = catalog(settings).map((entry) => sessionView(entry, target));
  const distro = target?.kind === 'wsl' ? target.distro : '';
  if (settings.autoInstall) {
    const installed = await installAssets(distro);
    if (!installed.ok) return { ok: false, views, error: installed.error };
  }
  const written = await writeSessionsBash(distro, views);
  if (!written.ok) return { ok: false, views, error: written.error };
  return { ok: true, views };
}

/* ------------------------------------------------------------------ */
/* http helpers                                                        */
/* ------------------------------------------------------------------ */

function isLoopback(req) {
  const remote = req.socket?.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function hostIsLocal(req) {
  const raw = String(req.headers?.host ?? '').toLowerCase();
  const name = raw.replace(/:\d+$/, '');
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* page                                                                */
/* ------------------------------------------------------------------ */

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cluster login</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 0 18px 28px; display: flex; justify-content: center; }
  .wrap { width: min(640px, 100%); }
  .bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px;
         padding: 9px 0 7px; margin-bottom: 8px; background: Canvas;
         border-bottom: 1px solid rgba(128,128,128,.28); }
  .bar.second { top: 40px; }
  .barlabel { color: #8a8a8a; font-size: 12px; letter-spacing: .06em; flex: none; }
  .pills { display: flex; gap: 6px; flex-wrap: wrap; }
  .pill { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; font: inherit; font-size: 13px;
          border-radius: 999px; border: 1px solid rgba(128,128,128,.45); background: transparent; color: inherit; cursor: pointer; }
  .pill:hover { border-color: #2f81f7; }
  .pill.on { background: #2f81f7; border-color: #2f81f7; color: #fff; }
  .pill .tag { font-size: 11px; opacity: .72; }
  select.pick { flex: 1; min-width: 0; padding: 7px 10px; font: inherit; font-size: 13px; border-radius: 8px;
                border: 1px solid rgba(128,128,128,.45); background: Canvas; color: inherit; }
  select.pick:focus { outline: 2px solid rgba(88,166,255,.6); outline-offset: 1px; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: #8a8a8a; margin: 0 0 16px; font-size: 13px; }
  .foot { color: #8a8a8a; font-size: 12px; line-height: 1.65; margin: 18px 0 0; padding-top: 12px;
          border-top: 1px dashed rgba(128,128,128,.3); }
  .card { border: 1px solid rgba(128,128,128,.35); border-radius: 12px; padding: 15px 17px; margin-bottom: 14px; }
  .row { display: flex; gap: 8px; align-items: baseline; margin: 5px 0; }
  .k { color: #8a8a8a; min-width: 84px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .on-dot { background: #2ea043; } .off-dot { background: #d1242f; } .wait-dot { background: #bf8700; }
  label { display: block; margin: 11px 0 4px; font-weight: 500; }
  input { width: 100%; box-sizing: border-box; padding: 9px 11px; font-size: 15px; border: 1px solid rgba(128,128,128,.45); border-radius: 8px; background: transparent; color: inherit; }
  input:focus { outline: 2px solid rgba(88,166,255,.6); outline-offset: 1px; }
  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  button.act { padding: 9px 15px; font-size: 14px; border-radius: 8px; border: 1px solid rgba(128,128,128,.45); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #2f81f7; border-color: #2f81f7; color: #fff; }
  button.act:disabled { opacity: .5; cursor: default; }
  .msg { margin-top: 13px; padding: 10px 12px; border-radius: 8px; font-size: 13px; white-space: pre-wrap; }
  .msg.ok { background: rgba(46,160,67,.14); color: #2ea043; }
  .msg.err { background: rgba(209,36,47,.14); color: #d1242f; }
  .msg.info { background: rgba(88,166,255,.14); }
  ul.checks { list-style: none; padding: 0; margin: 10px 0 0; font-size: 13px; }
  ul.checks li { padding: 3px 0; border-bottom: 1px dashed rgba(128,128,128,.2); }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="bar">
    <span class="barlabel">运行于</span>
    <div class="pills" id="pills"></div>
  </div>
  <div class="bar second">
    <span class="barlabel">会话</span>
    <select class="pick" id="sessionPick" aria-label="会话"></select>
  </div>

  <h1 id="title">Cluster login</h1>
  <p class="sub">Password + one-time code, once per session. Every session keeps its own 8-hour
  connection, and they run in parallel.</p>

  <div class="card">
    <div class="row"><span class="k">State</span><span id="stateText"><span class="dot wait-dot"></span>checking…</span></div>
    <div class="row"><span class="k">Session</span><span id="sessionText">-</span></div>
    <div class="row"><span class="k">Address</span><span id="targetText">-</span></div>
    <div class="row"><span class="k">Login node</span><span id="hostText">-</span></div>
    <div class="row"><span class="k">Account</span><span id="userText">-</span></div>
    <div class="row"><span class="k">Hint</span><span id="hintText" style="color:#8a8a8a">the campus VPN must be connected first</span></div>
  </div>

  <div class="card">
    <label for="uid">Account id</label>
    <input id="uid" type="text" autocomplete="username" placeholder="student / staff id">
    <label for="pw">Password</label>
    <input id="pw" type="password" autocomplete="current-password">
    <label for="otp">One-time code (OTP)</label>
    <input id="otp" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="6 digits from your authenticator">
    <div class="actions">
      <button class="act primary" id="loginBtn">Log in</button>
      <button class="act" id="refreshBtn">Refresh</button>
      <button class="act" id="diagBtn">Diagnose</button>
      <button class="act" id="logoutBtn">Disconnect</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card" id="diagCard" style="display:none">
    <div class="row"><span class="k">Diagnostics</span><span id="diagSummary">-</span></div>
    <ul class="checks" id="diagList"></ul>
  </div>

  <p class="sub">After login, ask the agent to run things &quot;on the cluster&quot;, or use
  <code>pku -c &lt;cluster&gt; status|run|push|sbatch</code>.</p>

  <p class="foot" id="footNote" style="display:none"></p>
</div>
<script>
(function () {
  var els = {};
  ['pills','sessionPick','title','stateText','sessionText','targetText','hostText','userText',
   'msg','uid','pw','otp','loginBtn','refreshBtn','diagBtn','logoutBtn','diagCard','diagList','diagSummary','footNote']
    .forEach(function (id) { els[id] = document.getElementById(id); });

  var view = { targets: [], activeTarget: '', sessions: [], selected: '', caveat: '', blocked: '' };

  function show(text, kind) {
    els.msg.className = 'msg ' + (kind || 'info');
    els.msg.textContent = text;
  }
  function busy(on) {
    [els.loginBtn, els.refreshBtn, els.diagBtn, els.logoutBtn].forEach(function (b) { b.disabled = on; });
  }
  function selected() {
    for (var i = 0; i < view.sessions.length; i += 1) {
      if (view.sessions[i].key === view.selected) return view.sessions[i];
    }
    return view.sessions[0] || null;
  }

  // Disabled targets are not offered at all: a pill you can only fail on is noise.
  function renderTargets() {
    els.pills.innerHTML = '';
    var usable = view.targets.filter(function (t) { return t.available !== false; });
    if (!usable.length) {
      var none = document.createElement('span');
      none.className = 'tag';
      none.textContent = '无可用执行目标';
      els.pills.appendChild(none);
      return;
    }
    usable.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pill' + (t.id === view.activeTarget ? ' on' : '');
      b.appendChild(document.createTextNode(t.label));
      if (t.detail) {
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = t.detail;
        b.appendChild(tag);
      }
      b.title = t.note || t.detail || t.label;
      b.addEventListener('click', function () {
        if (t.id !== view.activeTarget) switchTarget(t.id);
      });
      els.pills.appendChild(b);
    });
  }

  // One dropdown instead of a wall of pills: the bar stays one line high.
  function renderSessions() {
    var sel = els.sessionPick;
    sel.innerHTML = '';
    var groups = {};
    view.sessions.forEach(function (s) {
      if (!groups[s.cluster]) {
        var g = document.createElement('optgroup');
        g.label = s.clusterLabel;
        groups[s.cluster] = g;
        sel.appendChild(g);
      }
      var o = document.createElement('option');
      o.value = s.key;
      var endpointLabel = s.endpoint === 'data' ? '数据传输节点' : '登录节点';
      o.textContent = s.clusterLabel + ' · ' + endpointLabel + (s.master ? ' · 已连接' : '');
      if (s.key === view.selected) o.selected = true;
      groups[s.cluster].appendChild(o);
    });
  }

  function renderStatus() {
    var s = selected();
    if (!s) { els.title.textContent = 'Cluster login'; return; }
    els.title.textContent = s.label;
    els.stateText.innerHTML = '<span class="dot ' + (s.master ? 'on-dot' : 'off-dot') + '"></span>'
      + (s.master ? 'connected' : 'not connected');
    els.sessionText.textContent = s.key + (s.mode === 'relay' ? ' · relay' : '');
    els.targetText.textContent = s.target || '-';
    els.hostText.textContent = s.host || '-';
    els.userText.textContent = s.account || s.user || '-';
    if (s.user && !els.uid.value) els.uid.value = s.user;
  }

  // Anything worth warning about goes to the grey footnote, never a red box.
  function renderNote() {
    var s = selected();
    var line = view.blocked || view.caveat;
    if (!line && s && s.master && s.note) line = s.note;
    if (!line) { els.footNote.style.display = 'none'; els.loginBtn.disabled = false; return; }
    els.footNote.textContent = line;
    els.footNote.style.display = '';
    if (view.blocked) els.loginBtn.disabled = true;
  }

  function render() {
    renderTargets();
    renderSessions();
    renderStatus();
    renderNote();
  }

  function getState() {
    return fetch('api/state', { cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }
  function apply(state) {
    if (!state || !state.sessions) return;
    view.targets = state.targets || [];
    view.activeTarget = state.activeTarget || '';
    view.sessions = state.sessions || [];
    view.selected = state.selected || (view.sessions[0] ? view.sessions[0].key : '');
    view.caveat = state.caveat || '';
    view.blocked = state.blocked || '';
    render();
  }
  function reload() {
    return getState().then(apply).catch(function (e) { show('Status check failed: ' + e.message, 'err'); });
  }
  function switchTarget(id) {
    busy(true);
    show('Switching execution target…', 'info');
    post('api/target', { id: id })
      .then(function (r) { if (!r.ok) show('Switch failed: ' + (r.error || 'unknown'), 'err'); })
      .then(reload)
      .finally(function () { busy(false); });
  }

  function switchSession(key) {
    view.selected = key;
    post('api/select', { key: key }).catch(function () {});
    renderStatus();
    renderNote();
    var s = selected();
    show(s ? '已选择 ' + s.label + '。' : '', 'info');
  }

  els.sessionPick.addEventListener('change', function () {
    switchSession(els.sessionPick.value);
  });

  els.loginBtn.addEventListener('click', function () {
    var s = selected();
    if (!s) { show('No session available.', 'err'); return; }
    var user = els.uid.value.trim();
    var password = els.pw.value;
    var code = els.otp.value.trim();
    if (!user) { show('Account id is required.', 'err'); return; }
    if (!password) { show('Password is required.', 'err'); return; }
    if (!/^[0-9]{4,8}$/.test(code)) { show('The one-time code looks wrong (expect 6 digits).', 'err'); return; }
    busy(true);
    show('Signing in to ' + s.label + '… this can take 10-30 seconds.', 'info');
    post('api/login', { key: s.key, user: user, password: password, otp: code })
      .then(function (r) {
        els.pw.value = '';
        els.otp.value = '';
        if (r.ok && r.master) show('Logged in. ' + s.label + ' stays connected for 8 hours, in parallel with other sessions.', 'ok');
        else show('Login failed: ' + (r.error || 'unknown') + (r.stage ? ' (stage: ' + r.stage + ')' : ''), 'err');
        return reload();
      })
      .catch(function (e) { show('Request failed: ' + e.message, 'err'); })
      .finally(function () { busy(false); });
  });

  els.refreshBtn.addEventListener('click', function () {
    busy(true);
    reload().finally(function () { busy(false); });
  });

  els.diagBtn.addEventListener('click', function () {
    var s = selected();
    if (!s) return;
    busy(true);
    fetch('api/diagnose?key=' + encodeURIComponent(s.key), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        els.diagCard.style.display = '';
        els.diagSummary.textContent = d.ok ? 'all checks passed' : 'some checks failed';
        els.diagList.innerHTML = '';
        (d.checks || []).forEach(function (c) {
          var li = document.createElement('li');
          li.textContent = (c.ok ? '✓ ' : '✗ ') + c.check + ' — ' + c.detail + (c.fix && !c.ok ? ' → ' + c.fix : '');
          li.style.color = c.ok ? '' : '#d1242f';
          els.diagList.appendChild(li);
        });
        if (d.error) show(d.error, 'err');
      })
      .catch(function (e) { show('Diagnose failed: ' + e.message, 'err'); })
      .finally(function () { busy(false); });
  });

  els.logoutBtn.addEventListener('click', function () {
    var s = selected();
    if (!s) return;
    busy(true);
    post('api/logout', { key: s.key }).then(reload)
      .catch(function (e) { show('Disconnect failed: ' + e.message, 'err'); })
      .finally(function () { busy(false); });
  });

  reload();
  setInterval(reload, 10000);
})();
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) };
  const log = (message) => { try { ctx.logger?.warn?.(`pku-cluster: ${message}`); } catch { /* ignore */ } };

  clusters.ensureCatalogue(settings);

  const state = {
    targets: [],
    fetchedAt: 0,
    target: null,
    selectedTargetId: targetList.readSelected(),
    selectedSession: clusters.readSelectedSession(),
  };

  function currentTargets({ force = false } = {}) {
    if (!force && state.targets.length && Date.now() - state.fetchedAt < 4000) return state.targets;
    state.targets = targetList.listTargets();
    state.fetchedAt = Date.now();
    return state.targets;
  }

  function currentTarget() {
    const list = currentTargets();
    if (state.target && list.some((t) => t.id === state.target.id)) return state.target;
    state.target = targetList.resolveTarget(list, {
      selected: state.selectedTargetId,
      configuredDistro: settings.distro,
    });
    state.selectedTargetId = state.target?.id ?? state.selectedTargetId;
    return state.target;
  }

  const distroOf = (target) => (target?.kind === 'wsl' ? target.distro : '');

  /** Masters for every session, cheaply: one helper call per bash target. */
  async function sessionStatuses(target, views) {
    const result = await runBash(distroOf(target),
      'python3 "$HOME/.pku-cluster/login.py" --status-all', { timeoutMs: 60_000 });
    const payload = parsePayload(result);
    const byKey = new Map((payload.sessions ?? []).map((s) => [s.key, s]));
    return views.map((view) => ({ ...view, ...(byKey.get(view.key) ?? { master: false, reachable: false }) }));
  }

  function sessionByKey(key) {
    const target = currentTarget();
    const entry = catalog(settings).find((s) => s.key === key);
    if (!entry) return null;
    return { entry, view: sessionView(entry, target), target };
  }

  async function statePayload() {
    const target = currentTarget();
    if (!target) {
      return { ok: true, activeTarget: '', blocked: NO_TARGET_HINT, targets: [], sessions: [], selected: '' };
    }
    const entries = catalog(settings);
    const views = entries.map((entry) => sessionView(entry, target));
    const statuses = await sessionStatuses(target, views);
    const merged = entries.map((entry, index) => {
      const status = statuses[index] ?? {};
      return {
        key: entry.key,
        cluster: entry.cluster,
        clusterLabel: entry.clusterLabel,
        endpoint: entry.endpoint,
        label: entry.label,
        host: entry.host,
        mode: status.mode ?? views[index].mode,
        master: Boolean(status.master),
        note: status.error || '',
        reachable: Boolean(status.reachable),
        user: status.user ?? views[index].user,
        remainingMs: Number(status.remainingMs) || 0,
        account: status.account ?? '',
        target: status.target ?? `${entry.host}:${views[index].port}`,
      };
    });
    const selected = merged.some((s) => s.key === state.selectedSession)
      ? state.selectedSession
      : (merged[0]?.key ?? '');
    state.selectedSession = selected;
    return {
      ok: true,
      activeTarget: target?.id ?? '',
      blocked: target.available === false ? (target.note || NO_TARGET_HINT) : '',
      targets: currentTargets({ force: true }).map((t) => ({
        id: t.id, label: t.label, detail: t.detail ?? '', kind: t.kind,
        available: t.available !== false, note: t.note ?? '',
      })),
      sessions: merged,
      selected,
    };
  }

  // Install helpers and re-point session files off the load path: resolving a
  // target spawns wsl.exe, and a slow WSL service must not delay DSH startup.
  setImmediate(() => {
    syncSessions(currentTarget(), settings)
      .then((result) => log(result.ok
        ? `ready: ${result.views.length} sessions`
        : `cannot prepare sessions: ${result.error}`))
      .catch((e) => log(String(e?.message ?? e)));
  });

  const guard = (handler) => async (req, res) => {
    if (!isLoopback(req) || !hostIsLocal(req)) {
      return json(res, 403, { ok: false, error: 'loopback requests only' });
    }
    try {
      return await handler(req, res);
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  };

  ctx.effect(() => {
    const disposers = [];
    const route = (path, handler) => {
      disposers.push(ctx.webServer.register({ kind: 'exact', path, handler: guard(handler) }));
    };

    route(ROUTE_BASE, (req, res) => {
      res.writeHead(302, { location: `${ROUTE_BASE}/` });
      res.end();
    });

    route(`${ROUTE_BASE}/`, (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
      return html(res, PAGE);
    });

    route(`${ROUTE_BASE}/api/state`, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      return json(res, 200, await statePayload());
    });

    route(`${ROUTE_BASE}/api/target`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const id = typeof body?.id === 'string' ? body.id : '';
      const list = currentTargets({ force: true });
      const picked = list.find((t) => t.id === id);
      if (!picked) return json(res, 404, { ok: false, error: `unknown target: ${id}` });
      if (picked.available === false) {
        return json(res, 409, { ok: false, error: picked.note || `${picked.label} is not usable here` });
      }
      state.target = picked;
      state.selectedTargetId = id;
      targetList.writeSelected(id);
      const synced = await syncSessions(picked, settings);
      if (!synced.ok) return json(res, 200, { ok: false, error: synced.error });
      return json(res, 200, { ok: true });
    });

    route(`${ROUTE_BASE}/api/select`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const key = typeof body?.key === 'string' ? body.key : '';
      if (!catalog(settings).some((s) => s.key === key)) {
        return json(res, 404, { ok: false, error: `unknown session: ${key}` });
      }
      state.selectedSession = key;
      clusters.writeSelectedSession(key);
      return json(res, 200, { ok: true, selected: key });
    });

    route(`${ROUTE_BASE}/api/login`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const key = typeof body?.key === 'string' ? body.key : '';
      const user = typeof body?.user === 'string' ? body.user.trim() : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      const otp = typeof body?.otp === 'string' ? body.otp.trim() : '';
      if (user && !/^[0-9A-Za-z._-]{4,32}$/.test(user)) return json(res, 400, { ok: false, error: 'invalid account id' });
      if (!password || !/^[0-9]{4,8}$/.test(otp)) return json(res, 400, { ok: false, error: 'password or code malformed' });

      const found = sessionByKey(key);
      if (!found) return json(res, 404, { ok: false, error: `unknown session: ${key}` });
      const { target } = found;
      if (target?.available === false) {
        return json(res, 409, { ok: false, error: target.note || NO_TARGET_HINT });
      }
      const session = { ...found.view, user: user || found.view.user };

      if (session.mode === 'relay') {
        const relayed = await ensureRelay(session, settings.relayPort);
        if (!relayed.port) {
          return json(res, 200, {
            ok: false, stage: 'relay',
            error: 'the WSL relay could not start (no usable Windows address, or the port is taken)',
          });
        }
        session.relayPort = relayed.port;
        session.relayHost = relayed.address;
      }

      await writeSessionsBash(distroOf(target), [session]);

      const result = parsePayload(await runBash(distroOf(target),
        `python3 "$HOME/.pku-cluster/login.py" --session ${JSON.stringify(session.key)} --login`,
        { stdin: `${password}\n${otp}\n`, timeoutMs: 120_000 }));
      state.selectedSession = session.key;
      clusters.writeSelectedSession(session.key);
      return json(res, 200, { ...result, key: session.key });
    });

    route(`${ROUTE_BASE}/api/logout`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const found = sessionByKey(typeof body?.key === 'string' ? body.key : '');
      if (!found) return json(res, 404, { ok: false, error: 'unknown session' });
      const { target } = found;
      const result = parsePayload(await runBash(distroOf(target),
        `python3 "$HOME/.pku-cluster/login.py" --session ${JSON.stringify(found.view.key)} --logout`,
        { timeoutMs: 30_000 }));
      const entry = relays.get(found.view.key);
      if (entry) {
        try { entry.server.close(); } catch { /* ignore */ }
        relays.delete(found.view.key);
      }
      return json(res, 200, result);
    });

    route(`${ROUTE_BASE}/api/diagnose`, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      const url = new URL(req.url ?? '/', 'http://localhost');
      const found = sessionByKey(url.searchParams.get('key') ?? '');
      if (!found) return json(res, 404, { ok: false, error: 'unknown session' });
      const { target } = found;
      const result = parsePayload(await runBash(distroOf(target),
          `python3 "$HOME/.pku-cluster/login.py" --session ${JSON.stringify(found.view.key)} --diagnose`,
          { timeoutMs: 60_000 }));      const extra = {
        relay: relayStatus(found.view.key),
        exec: target?.kind === 'wsl' ? `wsl:${target.distro}` : 'local',
        platform: process.platform,
        session: found.view.key,
      };
      if (!Array.isArray(result.checks)) {
        return json(res, 200, {
          ...extra,
          ok: false,
          checks: [],
          error: result.error ?? 'the installed helper does not support --diagnose; set autoInstall: true '
            + 'or reinstall the plugin to refresh ~/.pku-cluster/login.py',
        });
      }
      return json(res, 200, { ...result, ...extra });
    });

    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
      closeRelays();
    };
  });
}
