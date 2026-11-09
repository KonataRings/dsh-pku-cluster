# Changelog

## 0.2.0 — 2026-11-02

**Multi-cluster sessions**

- **Four clusters, seven endpoints**: 未名一号 / 未名生科一号 / 未名教学二号 / 未名二号, including their
  data-transfer nodes. The catalogue lives in `~/.pku-cluster/clusters.json` and can be edited.
- **A session is cluster × endpoint** (`wm1:login`, `wm1:data`, …) and owns its own ControlMaster socket,
  so several clusters can stay logged in **in parallel**; disconnecting one leaves the others alone.
- **Target bar**: pick which WSL distribution (or the host itself on Linux/macOS) runs ssh; the choice is
  remembered in `target.json`, and a stopped distro is started on demand.
- The session picker is a grouped dropdown; environment warnings sit in a grey footnote.
- `pku -c <cluster>[:<endpoint>] …` plus `pku sessions`.
- WSL target: one relay per session. With `networkingMode=mirrored` there is no vEthernet, so the relay
  binds `127.0.0.1` instead.

**Fixes**

- The sidebar dot polled the retired `/api/status`, so it stayed red on a live connection. It now reads
  `/api/state`, turns green, and shows the remaining time beside the label; an idle session is a light
  grey dot rather than an alarm. `connectedAt` also survives `DEFAULTS` merging and session syncs.
- `login.py` uses `pty.fork()`. A bare `openpty()` pty is not a controlling terminal, and OpenSSH only
  prints its password prompt when it can open `/dev/tty`, so the driver sat till the timeout reporting
  `no password prompt seen`. See docs/troubleshooting.md for the reproduction.
- ssh destinations are the real hostnames, not the `pku` alias — a `Host pku` block in the user's own
  `~/.ssh/config` (for example `BindInterface`) used to break every connection.
- The helpers are copied with LF endings regardless of the checkout's `core.autocrlf`; `.gitattributes`
  keeps `resources/` LF as well, so a CRLF `#!/usr/bin/env bash` can no longer make `pku` exit 127.

**Breaking changes**

- `~/.pku-cluster/config.json` is replaced by `sessions/<cluster>-<endpoint>.json`. It is migrated once,
  keeping the account id, so no re-typing is needed; the old file is left untouched.
- `relayPort` no longer names the port the relay listens on: relays are allocated per session. If you had
  a firewall rule pinned to `2222`, set `relayPort: 2222` — the first session that needs a relay will try
  that port first and fall back to an ephemeral one when it is taken.
- There is no Windows-local target. Native Windows ssh cannot reuse a connection (Win32-OpenSSH has no
  ControlMaster; MSYS AF_UNIX cannot pass file descriptors, `mm_send_fd: sendmsg(2)`), so a target that
  re-asks for an OTP on every command was not shipped. Windows needs a WSL distribution.

## 0.1.2 — 2026-10-30

- Published to npm: `dsh plugin --profile <profile> add dsh-pku-cluster` now works.
- README: link the npm package page.

## 0.1.1 — 2026-10-30

- `Diagnose` now explains itself when the installed helper predates `--diagnose`
  (for example with `autoInstall: false`) instead of surfacing a misleading login error.
- README: document installing from a tarball, and warn that `git+https` needs Git on the machine
  (pnpm shells out to `git ls-remote`; without Git it fails with `ERR_PNPM_GIT_RESOLVE_FAILED`).

## 0.1.0 — 2026-10-30

First public release.

- Sidebar entry (“Connect cluster”) with a live status dot, plus an in-page login panel.
- Password + OTP sign-in; the OpenSSH ControlMaster is reused for 8 hours.
- Windows: a TCP relay runs **inside the plugin** so WSL can reach the cluster through the
  Windows VPN (Linux/macOS connect directly).
- Helper scripts (`login.py`, `pku`) and the connection config are installed on first load
  into `~/.pku-cluster/`, idempotently.
- The login driver uses only the Python standard library (`pty`), so no `pexpect`/pip step.
- “Diagnose” runs environment checks (python, pty, ssh, endpoint reachability, account id).
- Every HTTP route accepts loopback requests with a localhost Host header only.
- No credentials are stored: password and OTP travel over stdin and are discarded.
