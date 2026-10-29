# Changelog

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
