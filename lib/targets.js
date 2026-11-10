/**
 * Execution targets: where the ssh client and the helper scripts live.
 *
 *   local        - this machine (Windows native ssh, or bash on Linux/macOS)
 *   wsl:<name>   - a specific WSL distribution (Windows only)
 *
 * The plugin used to have exactly one implicit target (the first WSL distro).
 * Listing them here keeps that behaviour as the default while letting the page
 * switch, and keeps the Windows-local target honest about what it needs.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONF_DIR } from './paths.js';

export const IS_WINDOWS = process.platform === 'win32';
const LOCAL_ID = 'local';
const STATE_FILE = path.join(CONF_DIR, 'target.json');

/**
 * Parse `wsl.exe -l -v`. The output is UTF-16LE with a header row; the default
 * distribution is marked with `*`. Names may contain spaces, so the version is
 * read from the end rather than by a fixed column offset.
 */
export function parseWslList(text) {
  const distros = [];
  const lines = String(text)
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const isDefault = line.startsWith('*');
    const body = isDefault ? line.slice(1).trim() : line;
    const tokens = body.split(/\s+/);
    if (tokens.length < 3) continue;
    const version = tokens[tokens.length - 1];
    if (!/^\d+$/.test(version)) continue; // header row or noise
    const state = tokens[tokens.length - 2];
    const name = tokens.slice(0, -2).join(' ');
    if (!name) continue;
    distros.push({ name, state, version: Number(version), default: isDefault });
  }
  return distros;
}

export function listWslDistros() {
  if (!IS_WINDOWS) return [];
  for (const args of [['-l', '-v'], ['-l', '-q']]) {
    let result;
    try {
      result = spawnSync('wsl.exe', args, { encoding: 'buffer', timeout: 15_000, windowsHide: true });
    } catch {
      continue;
    }
    if (result?.status !== 0 || !result.stdout?.length) continue;
    const text = result.stdout.toString('utf16le');
    if (args[1] === '-q') {
      return text
        .replace(/\u0000/g, '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((name) => ({ name, state: '', version: 0, default: false }));
    }
    const parsed = parseWslList(text);
    if (parsed.length) return parsed;
  }
  return [];
}

/**
 * On Linux/macOS the host itself is the only target and it works: bash plus the
 * python driver run natively. Windows has no such target — native ssh cannot
 * reuse a connection (Win32-OpenSSH has no ControlMaster; MSYS cannot pass file
 * descriptors over AF_UNIX), so only WSL distributions are offered there.
 */
function localTarget() {
  return { id: LOCAL_ID, kind: 'local', label: '本机', detail: '直接在本机执行', available: true, note: '' };
}

/** Every target this machine can offer, newest state included. */
export function listTargets() {
  const targets = IS_WINDOWS ? [] : [localTarget()];
  for (const distro of listWslDistros()) {
    targets.push({
      id: `wsl:${distro.name}`,
      kind: 'wsl',
      label: distro.name,
      detail: [distro.state, distro.version ? `WSL${distro.version}` : ''].filter(Boolean).join(' · '),
      available: true,
      default: distro.default,
      distro: distro.name,
      state: distro.state,
      note: '',
    });
  }
  return targets;
}

export function readSelected() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return typeof raw?.id === 'string' ? raw.id : '';
  } catch {
    return '';
  }
}

export function writeSelected(id) {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify({ id }, null, 2)}\n`);
  } catch { /* a read-only profile is not fatal: the choice just will not persist */ }
}

/**
 * Pick the target to use. Order: the saved choice, then the configured distro,
 * then WSL's own default, then the local machine.
 */
export function resolveTarget(targets, { selected, configuredDistro } = {}) {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const usable = (target) => Boolean(target) && target.available !== false;
  const saved = selected || readSelected();
  if (usable(byId.get(saved))) return byId.get(saved);
  if (usable(byId.get(`wsl:${configuredDistro}`))) return byId.get(`wsl:${configuredDistro}`);
  const preferred = targets.find((t) => t.kind === 'wsl' && t.default && usable(t));
  if (preferred) return preferred;
  const wsl = targets.find((t) => t.kind === 'wsl' && usable(t));
  if (wsl) return wsl;
  // Nothing usable (a Windows box with no WSL distro): return the disabled local
  // target so the page can explain why instead of showing an empty picker.
  return targets.find(usable) ?? byId.get(LOCAL_ID) ?? targets[0];
}

export function targetExists(id) {
  return listTargets().some((t) => t.id === id);
}

export { LOCAL_ID, STATE_FILE };
