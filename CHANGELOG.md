# Changelog

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
