/**
 * The cluster catalogue and the sessions built from it.
 *
 * A *cluster* is a name plus a login node and (optionally) a data-transfer
 * node. A *session* is one ssh connection to one endpoint of one cluster, and
 * it is the unit that can be logged in independently — which is what makes
 * parallel sessions possible: every session owns its own ControlMaster socket,
 * so logging in to 未名一号 does not disturb 未名二号.
 *
 * Session keys are `<cluster>:<endpoint>`, e.g. `wm1:login` / `wm1:data`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  CLUSTERS_FILE, CONF_DIR, CONTROL_ROOT, IS_WINDOWS, LEGACY_CONFIG, SESSIONS_DIR, SELECTED_FILE, safeName,
} from './paths.js';

export const DEFAULT_CLUSTERS = [
  { id: 'wmjx2', label: '未名教学二号', login: 'wmjx2-login.pku.edu.cn', data: '' },
  { id: 'wm1', label: '未名一号', login: 'wm1-login.pku.edu.cn', data: 'wm1-data.pku.edu.cn' },
  { id: 'wmsk1', label: '未名生科一号', login: 'wmsk1-login.pku.edu.cn', data: 'wmsk1-data.pku.edu.cn' },
  { id: 'wm2', label: '未名二号', login: 'wm2-login.pku.edu.cn', data: 'wm2-data.pku.edu.cn' },
];

const LEGACY_DEFAULT_HOST = 'wmjx2-login.pku.edu.cn';

function readFileJson(file, fallback) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return raw ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Clusters the user can pick: the built-in ones, overridden by clusters.json,
 * plus a "custom" entry when the plugin is configured with an unknown loginHost.
 */
export function readClusters(settings = {}) {
  const stored = readFileJson(CLUSTERS_FILE, []);
  // The file, when present, is the whole catalogue: a cluster removed there
  // must not come back from the built-in defaults. Defaults only seed it.
  const source = Array.isArray(stored) && stored.length ? stored : DEFAULT_CLUSTERS;
  const list = [];
  const seen = new Set();
  for (const entry of source) {
    const id = String(entry?.id ?? '').trim();
    const login = String(entry?.login ?? '').trim();
    if (!id || !login || seen.has(id)) continue;
    seen.add(id);
    list.push({
      id,
      label: String(entry.label ?? id),
      login,
      data: String(entry.data ?? ''),
      port: Number(entry.port) || 22,
    });
  }
  const configured = String(settings.loginHost ?? '').trim();
  if (configured && !list.some((c) => c.login === configured)) {
    list.push({ id: 'custom', label: '自定义', login: configured, data: '', port: 22 });
  }
  return list;
}

export function endpointsOf(cluster) {
  const port = Number(cluster.port) || 22;
  const list = [{ endpoint: 'login', host: cluster.login, port }];
  if (cluster.data) list.push({ endpoint: 'data', host: cluster.data, port });
  return list;
}

export const sessionKey = (clusterId, endpoint) => `${clusterId}:${endpoint}`;

export function parseSessionKey(key) {
  const [cluster, endpoint = 'login'] = String(key ?? '').split(':');
  return { cluster, endpoint };
}

/** Flat list of every session this machine could open. */
export function listSessions(settings = {}) {
  const out = [];
  for (const cluster of readClusters(settings)) {
    for (const { endpoint, host, port } of endpointsOf(cluster)) {
      out.push({
        key: sessionKey(cluster.id, endpoint),
        cluster: cluster.id,
        clusterLabel: cluster.label,
        endpoint,
        endpointLabel: endpoint === 'data' ? '数据传输' : '登录节点',
        label: `${cluster.label} · ${endpoint === 'data' ? '数据传输' : '登录节点'}`,
        host,
        port,
      });
    }
  }
  return out;
}

export function sessionFile(key) {
  return path.join(SESSIONS_DIR, `${safeName(String(key).replace(':', '-'))}.json`);
}

export function readSession(key) {
  return readFileJson(sessionFile(key), null);
}

export function writeSession(key, data) {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(sessionFile(key), `${JSON.stringify({ key, ...data }, null, 2)}\n`);
  return data;
}

/**
 * Control socket directory: namespaced by session and by execution target.
 *
 * Inside a WSL distro a Windows path is meaningless, so for bash targets this
 * returns '' and the driver derives `~/.pku-cluster/cm/<key>/` in that
 * environment (login.py and `pku` compute the same string from the key).
 */
export function controlPathFor(target, key) {
  if (IS_WINDOWS && target?.kind !== 'local') return '';
  const targetPart = target?.kind === 'wsl' ? `wsl-${safeName(target.distro)}` : 'local';
  return path.join(CONTROL_ROOT, targetPart, safeName(key), '%r@%h-%p');
}

export function readSelectedSession() {
  const raw = readFileJson(SELECTED_FILE, null);
  return typeof raw?.key === 'string' ? raw.key : '';
}

export function writeSelectedSession(key) {
  try {
    mkdirSync(CONF_DIR, { recursive: true });
    writeFileSync(SELECTED_FILE, `${JSON.stringify({ key }, null, 2)}\n`);
  } catch { /* selection is a convenience; a read-only profile may refuse it */ }
}

/** Create the catalogue and migrate a pre-0.3 `config.json` into a session. */
export function ensureCatalogue(settings = {}) {
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    if (!existsSync(CLUSTERS_FILE)) {
      writeFileSync(CLUSTERS_FILE, `${JSON.stringify(DEFAULT_CLUSTERS, null, 2)}\n`);
    }
  } catch { /* ignore: the plugin still works with the built-in list */ }

  let existing = [];
  try { existing = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { existing = []; }
  if (existing.length) return;

  const legacy = readFileJson(LEGACY_CONFIG, null);
  if (!legacy || typeof legacy !== 'object') return;
  const host = String(legacy.loginHost ?? '').trim() || LEGACY_DEFAULT_HOST;
  const match = readClusters(settings).find((c) => c.login === host);
  const cluster = match?.id ?? 'custom';
  writeSession(sessionKey(cluster, 'login'), {
    cluster,
    endpoint: 'login',
    host,
    port: Number(legacy.loginPort) || 22,
    user: typeof legacy.user === 'string' ? legacy.user : '',
    mode: legacy.mode === 'relay' ? 'relay' : 'direct',
    relayPort: Number(legacy.relayPort) || 2222,
  });
}
