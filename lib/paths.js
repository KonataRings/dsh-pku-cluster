/**
 * Where the plugin keeps its state.
 *
 * Two homes, deliberately: the *host* keeps the cluster catalogue, the target
 * choice and the selected session, while every *session* file lives in the
 * directory of the environment that actually runs ssh (a WSL distro has its own
 * home, so a WSL session's file is written inside that distro). Keeping the
 * paths in one module is what lets both drivers agree on the control socket.
 */

import os from 'node:os';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

// PKU_CLUSTER_DIR exists so tests (and packaging checks) can run against a
// throwaway directory instead of the user's real configuration.
export const CONF_DIR = process.env.PKU_CLUSTER_DIR
  ? path.resolve(process.env.PKU_CLUSTER_DIR)
  : path.join(os.homedir(), '.pku-cluster');

export const SESSIONS_DIR = path.join(CONF_DIR, 'sessions');
export const CONTROL_ROOT = path.join(CONF_DIR, 'cm');
export const CLUSTERS_FILE = path.join(CONF_DIR, 'clusters.json');
export const TARGET_FILE = path.join(CONF_DIR, 'target.json');
export const SELECTED_FILE = path.join(CONF_DIR, 'selected-session.json');
export const LEGACY_CONFIG = path.join(CONF_DIR, 'config.json');

/** A name that is safe on both NTFS and POSIX. */
export function safeName(value) {
  return String(value).replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}
