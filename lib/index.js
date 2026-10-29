/**
 * dsh-pku-cluster — PKU Weiming Teaching-2 cluster for DeepSeek Harness.
 *
 * Public build. Everything instance-specific is configuration:
 *
 *   - loginHost / loginPort   where the cluster's login node lives
 *   - distro                  which WSL distro to drive (Windows only)
 *   - relayPort               loopback port used on Windows
 *
 * Why a relay on Windows: the Windows VPN client (e.g. iSecSP / Array TAP)
 * gives the Windows stack campus reachability, but WSL2 keeps its own NAT and
 * does not inherit it (mirrored networking does not help for point-to-point
 * TAP adapters either). So on Windows this plugin listens on the WSL host
 * address and forwards to the login node; WSL's ssh connects to that relay.
 * On Linux/macOS the VPN is system-wide and ssh connects directly.
 *
 * Credentials never touch disk: the password and OTP travel over stdin to a
 * pexpect driver, and the multiplexed ssh connection is owned by OpenSSH.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';

export const name = 'pku-cluster';
export const inject = ['webServer'];

const ROUTE_BASE = '/plugins/dsh-pku-cluster';
const IS_WINDOWS = process.platform === 'win32';

const DEFAULTS = {
  loginHost: 'wmjx2-login.pku.edu.cn',
  loginPort: 22,
  relayPort: 2222,
  distro: '',        // '' -> first distro reported by `wsl.exe -l -q`
  autoInstall: true, // write helper scripts into the user's shell
};

/* ------------------------------------------------------------------ */
/* shell plumbing                                                      */
/* ------------------------------------------------------------------ */

let resolvedDistro;

function detectDistro() {
  if (resolvedDistro !== undefined) return resolvedDistro;
  if (!IS_WINDOWS) return (resolvedDistro = '');
  try {
    const r = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 15000 });
    const text = (r.stdout ?? Buffer.alloc(0)).toString('utf16le').replace(/\u0000/g, '');
    resolvedDistro = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? '';
  } catch {
    resolvedDistro = '';
  }
  return resolvedDistro;
}

function shellInvocation(settings, command) {
  if (!IS_WINDOWS) return ['bash', ['-lc', command]];
  const distro = settings.distro || detectDistro();
  return distro
    ? ['wsl.exe', ['-d', distro, '-e', 'bash', '-lc', command]]
    : ['wsl.exe', ['-e', 'bash', '-lc', command]];
}

/** Run a shell command inside the target environment (WSL on Windows). */
function runShell(settings, command, { stdin = '', timeoutMs = 45_000 } = {}) {
  const [file, args] = shellInvocation(settings, command);
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

/** The driver prints one JSON line; keep the last parseable one. */
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
/* helper assets                                                       */
/* ------------------------------------------------------------------ */

function assetText(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

const ASSETS = [
  { path: 'login.py', mode: '700', text: () => assetText('../resources/login.py') },
  { path: 'pku', mode: '700', text: () => assetText('../resources/pku') },
];

async function readRemoteConfig(settings) {
  const r = await runShell(settings, 'cat "$HOME/.pku-cluster/config.json" 2>/dev/null || true',
    { timeoutMs: 20_000 });
  if (r.error) return null;
  try {
    const value = JSON.parse(String(r.out).trim());
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Write the driver, the `pku` helper and the connection config. Idempotent. */
async function installAssets(settings, overrides = {}) {
  const existing = (await readRemoteConfig(settings)) ?? {};
  const config = {
    mode: IS_WINDOWS ? 'relay' : 'direct',
    loginHost: settings.loginHost,
    loginPort: Number(settings.loginPort) || 22,
    relayPort: Number(settings.relayPort) || 2222,
    user: typeof existing.user === 'string' ? existing.user : '',
    ...overrides,
  };

  for (const asset of ASSETS) {
    const text = asset.text();
    const cmd = `mkdir -p "$HOME/.pku-cluster" && cat > "$HOME/.pku-cluster/${asset.path}" && chmod ${asset.mode} "$HOME/.pku-cluster/${asset.path}"`;
    const r = await runShell(settings, cmd, { stdin: text, timeoutMs: 30_000 });
    if (r.error || r.code !== 0) {
      return { ok: false, error: `failed to install ${asset.path}: ${r.error ?? r.err ?? ''}`.trim() };
    }
  }

  const payload = `${JSON.stringify(config, null, 2)}\n`;
  const r = await runShell(settings,
    'mkdir -p "$HOME/.pku-cluster" && cat > "$HOME/.pku-cluster/config.json" && chmod 600 "$HOME/.pku-cluster/config.json"',
    { stdin: payload, timeoutMs: 30_000 });
  if (r.error || r.code !== 0) {
    return { ok: false, error: `failed to write config: ${r.error ?? r.err ?? ''}`.trim() };
  }
  return { ok: true, config };
}

/* ------------------------------------------------------------------ */
/* relay (Windows only)                                                */
/* ------------------------------------------------------------------ */

const relay = { server: null, address: null, timer: null };

function wslHostAddress() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (!/wsl/i.test(name)) continue;
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null;
}

function ensureRelay(settings) {
  if (!IS_WINDOWS) return;
  if (relay.server) return;
  const address = wslHostAddress();
  if (!address) {
    if (!relay.timer) {
      relay.timer = setTimeout(() => { relay.timer = null; ensureRelay(settings); }, 5000);
      if (typeof relay.timer.unref === 'function') relay.timer.unref();
    }
    return;
  }
  const target = { host: settings.loginHost, port: Number(settings.loginPort) || 22, family: 4 };
  const server = net.createServer((client) => {
    const upstream = net.connect(target, () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    const destroy = () => { client.destroy(); upstream.destroy(); };
    client.on('error', destroy);
    upstream.on('error', destroy);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  server.on('error', () => { relay.server = null; });
  server.listen(Number(settings.relayPort) || 2222, address, () => {
    relay.server = server;
    relay.address = address;
  });
}

function closeRelay() {
  if (relay.timer) { clearTimeout(relay.timer); relay.timer = null; }
  if (relay.server) { try { relay.server.close(); } catch { /* ignore */ } relay.server = null; }
  relay.address = null;
}

function relayStatus() {
  if (!IS_WINDOWS) return { mode: 'direct', listening: false };
  return { mode: 'relay', listening: Boolean(relay.server), address: relay.address,
           port: Number(relay.server?.address()?.port ?? 0) || null };
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cluster login</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 28px 18px; display: flex; justify-content: center; }
  .wrap { width: min(600px, 100%); }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: #8a8a8a; margin: 0 0 20px; font-size: 13px; }
  .card { border: 1px solid rgba(128,128,128,.35); border-radius: 12px; padding: 15px 17px; margin-bottom: 14px; }
  .row { display: flex; gap: 8px; align-items: baseline; margin: 5px 0; }
  .k { color: #8a8a8a; min-width: 84px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .on { background: #2ea043; } .off { background: #d1242f; } .wait { background: #bf8700; }
  label { display: block; margin: 11px 0 4px; font-weight: 500; }
  input { width: 100%; box-sizing: border-box; padding: 9px 11px; font-size: 15px; border: 1px solid rgba(128,128,128,.45); border-radius: 8px; background: transparent; color: inherit; }
  input:focus { outline: 2px solid rgba(88,166,255,.6); outline-offset: 1px; }
  .actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
  button { padding: 9px 15px; font-size: 14px; border-radius: 8px; border: 1px solid rgba(128,128,128,.45); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #2f81f7; border-color: #2f81f7; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
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
  <h1>Cluster login</h1>
  <p class="sub">Password + one-time code, once. The connection is reused for 8 hours.</p>

  <div class="card">
    <div class="row"><span class="k">State</span><span id="stateText"><span class="dot wait"></span>checking…</span></div>
    <div class="row"><span class="k">Target</span><span id="targetText">-</span></div>
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
      <button class="primary" id="loginBtn">Log in</button>
      <button id="refreshBtn">Refresh</button>
      <button id="diagBtn">Diagnose</button>
      <button id="logoutBtn">Disconnect</button>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card" id="diagCard" style="display:none">
    <div class="row"><span class="k">Diagnostics</span><span id="diagSummary">-</span></div>
    <ul class="checks" id="diagList"></ul>
  </div>

  <p class="sub">After login, ask the agent to run things &quot;on the cluster&quot;, or use <code>pku status|run|push|pull|sbatch</code>.</p>
</div>
<script>
(function () {
  var stateText = document.getElementById('stateText');
  var targetText = document.getElementById('targetText');
  var hostText = document.getElementById('hostText');
  var userText = document.getElementById('userText');
  var msg = document.getElementById('msg');
  var uid = document.getElementById('uid');
  var pw = document.getElementById('pw');
  var otp = document.getElementById('otp');
  var loginBtn = document.getElementById('loginBtn');
  var refreshBtn = document.getElementById('refreshBtn');
  var diagBtn = document.getElementById('diagBtn');
  var logoutBtn = document.getElementById('logoutBtn');
  var diagCard = document.getElementById('diagCard');
  var diagList = document.getElementById('diagList');
  var diagSummary = document.getElementById('diagSummary');

  function show(text, kind) {
    msg.className = 'msg ' + (kind || 'info');
    msg.textContent = text;
  }
  function busy(on) {
    [loginBtn, refreshBtn, diagBtn, logoutBtn].forEach(function (b) { b.disabled = on; });
  }
  function render(s) {
    var dot = s.master ? 'on' : 'off';
    stateText.innerHTML = '<span class="dot ' + dot + '"></span>' + (s.master ? 'connected' : 'not connected');
    targetText.textContent = s.target || '-';
    hostText.textContent = s.host || '-';
    userText.textContent = s.account || s.user || '-';
    if (s.user && !uid.value) uid.value = s.user;
  }
  function getStatus() {
    return fetch('api/status', { cache: 'no-store' }).then(function (r) { return r.json(); });
  }
  function load() {
    return getStatus().then(function (s) {
      render(s);
      if (!s.master) show('Not connected. Fill in the fields and press Log in.', 'info');
      else if (msg.className.indexOf('ok') === -1) show('Connection is up.', 'ok');
    }).catch(function (e) { show('Status check failed: ' + e.message, 'err'); });
  }
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  loginBtn.addEventListener('click', function () {
    var user = uid.value.trim();
    var password = pw.value;
    var code = otp.value.trim();
    if (!user) { show('Account id is required.', 'err'); return; }
    if (!password) { show('Password is required.', 'err'); return; }
    if (!/^[0-9]{4,8}$/.test(code)) { show('The one-time code looks wrong (expect 6 digits).', 'err'); return; }
    busy(true);
    show('Signing in… this can take 10-30 seconds.', 'info');
    post('api/login', { user: user, password: password, otp: code })
      .then(function (s) {
        pw.value = '';
        otp.value = '';
        if (s.ok && s.master) show('Logged in. No password or code needed for the next 8 hours.', 'ok');
        else show('Login failed: ' + (s.error || 'unknown') + (s.stage ? ' (stage: ' + s.stage + ')' : ''), 'err');
        return getStatus();
      })
      .then(render)
      .catch(function (e) { show('Request failed: ' + e.message, 'err'); })
      .finally(function () { busy(false); });
  });

  refreshBtn.addEventListener('click', function () { busy(true); load().finally(function () { busy(false); }); });

  diagBtn.addEventListener('click', function () {
    busy(true);
    fetch('api/diagnose', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        diagCard.style.display = '';
        diagSummary.textContent = d.ok ? 'all checks passed' : 'some checks failed';
        diagList.innerHTML = '';
        (d.checks || []).forEach(function (c) {
          var li = document.createElement('li');
          li.textContent = (c.ok ? '\\u2713 ' : '\\u2717 ') + c.check + ' — ' + c.detail + (c.fix && !c.ok ? ' → ' + c.fix : '');
          li.style.color = c.ok ? '' : '#d1242f';
          diagList.appendChild(li);
        });
      })
      .catch(function (e) { show('Diagnose failed: ' + e.message, 'err'); })
      .finally(function () { busy(false); });
  });

  logoutBtn.addEventListener('click', function () {
    busy(true);
    post('api/logout', {}).then(getStatus).then(render)
      .catch(function (e) { show('Disconnect failed: ' + e.message, 'err'); })
      .finally(function () { busy(false); });
  });

  load();
  setInterval(function () { load(); }, 10000);
})();
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) };
  const log = (msg) => { try { ctx.logger?.warn?.(`pku-cluster: ${msg}`); } catch { /* ignore */ } };

  ensureRelay(settings);
  if (settings.autoInstall) {
    installAssets(settings).then((r) => {
      if (!r.ok) log(r.error);
    }).catch((e) => log(String(e?.message ?? e)));
  }

  const call = (args, stdin, timeoutMs) =>
    runShell(settings, `python3 "$HOME/.pku-cluster/login.py" ${args.join(' ')}`, { stdin, timeoutMs })
      .then(parsePayload);

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

    route(`${ROUTE_BASE}/api/status`, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      return json(res, 200, { ...(await call(['--status'], '', 45_000)), relay: relayStatus() });
    });

    route(`${ROUTE_BASE}/api/config`, async (req, res) => {
      if (req.method === 'GET') {
        const s = await call(['--status'], '', 45_000);
        return json(res, 200, { ok: true, user: s.user ?? '' });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const user = typeof body?.user === 'string' ? body.user.trim() : '';
      if (!/^[0-9A-Za-z._-]{4,32}$/.test(user)) return json(res, 400, { ok: false, error: 'invalid account id' });
      return json(res, 200, await call(['--user', user], '', 30_000));
    });

    route(`${ROUTE_BASE}/api/login`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const user = typeof body?.user === 'string' ? body.user.trim() : '';
      const password = typeof body?.password === 'string' ? body.password : '';
      const otp = typeof body?.otp === 'string' ? body.otp.trim() : '';
      if (user && !/^[0-9A-Za-z._-]{4,32}$/.test(user)) return json(res, 400, { ok: false, error: 'invalid account id' });
      if (!password || !/^[0-9]{4,8}$/.test(otp)) return json(res, 400, { ok: false, error: 'password or code malformed' });
      ensureRelay(settings);
      if (user) {
        const saved = await call(['--user', user], '', 30_000);
        if (!saved.ok) return json(res, 400, saved);
      }
      // Password and OTP only ever travel over stdin to the driver.
      return json(res, 200, await call(['--login'], `${password}\n${otp}\n`, 120_000));
    });

    route(`${ROUTE_BASE}/api/logout`, async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      return json(res, 200, await call(['--logout'], '', 30_000));
    });

    route(`${ROUTE_BASE}/api/diagnose`, async (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      const result = await call(['--diagnose'], '', 60_000);
      const extra = {
        relay: relayStatus(),
        platform: process.platform,
        loginHost: settings.loginHost,
        loginPort: settings.loginPort,
      };
      if (!Array.isArray(result.checks)) {
        // An older helper (or a helper installed with autoInstall:false) may not
        // understand --diagnose; say so instead of echoing its login error.
        return json(res, 200, {
          ...extra,
          ok: false,
          checks: [],
          error: 'the installed helper does not support --diagnose; set autoInstall: true '
            + 'or reinstall the plugin to refresh ~/.pku-cluster/login.py',
        });
      }
      return json(res, 200, { ...result, ...extra });
    });

    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* ignore */ }
      }
      closeRelay();
    };
  });
}

