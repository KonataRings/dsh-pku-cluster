# Changelog

## 0.2.3 — 2026-11-18

**Fixes**

- The relay address no longer disappears from the session file. Every rewrite (startup and execution-target
  switch) wrote `relayHost: ""`, so `pku` and the driver fell back to the WSL default gateway while the
  master was still alive; under `networkingMode=mirrored` that made a live session report "not connected"
  again after a target switch. The session view now carries the address of the relay that is actually
  listening, and never a stale one.
- `pku` defaults a missing or zero `relayPort` to 2222, the same fallback `login.py` applies, so the two
  cannot dial different ports for one session. It also prefers `loginHost` over `host` in direct mode,
  which is the field the driver dials when a file carries both.
- A hung ssh is reported as `timed out waiting for ssh to finish` instead of "no password prompt seen": the
  deadline check now runs before the prompt diagnostics, and the grace window after it is 1 s, not 5 s.
- Error details no longer quote the pty buffer blindly. Prompt lines and echoed answers are skipped, so a
  failed login cannot put the password or the one-time code on the page.
- Session files are read and written as UTF-8. A Chinese `label` made a locale-dependent decode fail, and
  that failure was swallowed as "no session file" — which dropped the very fields the merge exists to keep.

**Verification**

- `tests/test_login_prompts.py` drives the prompt state machine against a fake `ssh` (re-prompted password
  and code, denial, silent failure, connection refused, hung child) and checks that `save_config` keeps the
  plugin-owned fields and backfills `host`.
- `tests/test_pku.sh` checks the socket path `pku` derives for relay, direct and legacy session files, plus
  the stale-socket cleanup. Both run in CI.

## 0.2.2 — 2026-11-17

**Fixes**

- `pku` ignored the session's `relayHost` and dialled the WSL default gateway instead, so `-O check`
  expanded `%h` to that gateway and never found the master the plugin created
  (`…@198.18.0.2-1122` versus `…@127.0.0.1-1122`). Every command reported "not connected" for a live
  session. It now resolves the target exactly like `login.py`: `relayHost` when set (the gateway is only
  a fallback), plus the session's `relayPort`.
- `login.py` rewrote the session file from `DEFAULTS` on save and dropped the fields the plugin owns
  (`host`, `cluster`, `endpoint`, `label`). A session that logged in once lost `host`, after which the
  derived ControlPath no longer matched. `save_config` merges instead, `host` is part of `DEFAULTS`, and
  older files get `host` backfilled from `loginHost`.
- `pku` runs ssh with `BatchMode=yes`, `ConnectTimeout=20` and no password authentication, so a dead
  master fails immediately instead of waiting for a prompt. A stale socket is removed and the checked
  path is printed; `pku down` cleans one up too.

**Verification**

- Live `wmjx2` session: `pku -c wmjx2:login status` prints the login node (previously "not connected").
- Fabricated stale socket: `pku status` fails in 43 ms, removes the socket and names the path.

## 0.2.1 — 2026-11-16

**Fixes**

- A wrong one-time code hung for the full 90 s driver deadline and then reported the misleading stage
  `post`. A rejected credential makes ssh prompt again, so the driver now treats a repeated prompt (or
  `Permission denied`) as the failure signal: it kills the child and returns in ~150 ms with `stage: otp`
  or `stage: password`. ssh also runs with `NumberOfPasswordPrompts=1`, and every exit path reaps the
  child, so a mistyped code no longer leaves a stale ssh process holding a pty.
- The pty deadline dropped from 90 s to 45 s, and a run that reaches it is reaped instead of left behind.
- The page now distinguishes "already connected" from "credentials accepted": `already: true` shows an
  informational line and points at Disconnect, instead of implying the password and code were verified.
- The sidebar entry is registered with `id` and falls back to `key`, and a rejected registration can no
  longer escape `apply()` — that exception used to blank the whole sidebar.

**Compatibility**

- Verified against DSH 0.2.2-rc.3: the host routes are unchanged and the footer seat still takes `id`.


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

- DSH 0.2.1 list slots address their entries by `id`. Registering with any other field throws while
  the client bundle loads, so a wrong key hides the entry *and* takes the whole sidebar down; `apply()`
  now also returns quietly when the `slots` service is absent instead of throwing.
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
