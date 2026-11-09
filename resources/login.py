#!/usr/bin/env python3
"""PKU cluster login driver (stdlib only).

Reads one *session* file under ~/.pku-cluster/sessions/ and establishes an SSH
ControlMaster connection using a password + OTP (the cluster offers no key
auth). No third-party packages: the password/OTP prompts are answered through a
pseudo-terminal opened with the standard `pty` module.

A session is one endpoint of one cluster, e.g. `wm1:login` or `wm1:data`. Each
session has its own ControlPath, so several clusters can stay logged in at once.

Modes:
  relay  - Windows hosts: ssh connects to a loopback relay on the WSL host
           gateway, because WSL does not inherit the Windows VPN.
  direct - Linux/macOS, and the Windows-local target: ssh connects straight to
           the endpoint.

Usage:
  login.py --session <key> --status      connection state (JSON)
  login.py --session <key> --logout      drop the ControlMaster
  login.py --session <key> --user <id>   store the account id
  login.py --session <key> --diagnose    environment checks (JSON)
  login.py --session <key> --login       read password + OTP from stdin, connect
  login.py --status-all                  state of every session (JSON)
"""
from __future__ import annotations

import json
import os
import pathlib
import pty
import re
import select
import shutil
import socket
import subprocess
import sys
import time

HOME = pathlib.Path.home()
CONF_DIR = HOME / ".pku-cluster"
SESSIONS_DIR = CONF_DIR / "sessions"
LEGACY_CONF = CONF_DIR / "config.json"

DEFAULTS = {
    "key": "",
    "cluster": "",
    "endpoint": "login",
    "mode": "direct",
    "loginHost": "",
    "loginPort": 22,
    "relayHost": "",  # empty = derive from the default gateway
    "relayPort": 2222,
    "controlPath": "",
    "user": "",
    # Epoch ms of the successful login. load_config only copies the fields
    # listed here, so anything remaining_ms needs must be declared in DEFAULTS.
    "connectedAt": 0,
}

PASSWORD_PROMPT = re.compile(r"(?i)password\s*:?\s*$")
OTP_PROMPT = re.compile(r"(?i)verification\s+code\s*:?\s*$")
DENIED = re.compile(r"(?i)permission\s+denied|authentication\s+failed")

CONTROL_PERSIST = "8h"
# Mirrors ControlPersist above; used to report the remaining time.
PERSIST_MS = 8 * 60 * 60 * 1000


def slug(value: str) -> str:
    return re.sub(r"[^0-9A-Za-z._-]+", "-", value.replace(":", "-")) or "x"


def session_path(key: str) -> pathlib.Path:
    return SESSIONS_DIR / f"{slug(key)}.json"


def session_key(argv: list[str]) -> str:
    for i, arg in enumerate(argv):
        if arg == "--session" and i + 1 < len(argv):
            return argv[i + 1].strip()
        if arg.startswith("--session="):
            return arg.split("=", 1)[1].strip()
    return os.environ.get("PKU_SESSION", "").strip()


def load_config(key: str) -> dict:
    conf = dict(DEFAULTS)
    conf["key"] = key
    path = session_path(key) if key else LEGACY_CONF
    try:
        raw = json.loads(path.read_text())
        if isinstance(raw, dict):
            for field in DEFAULTS:
                if field in raw:
                    conf[field] = raw[field]
            if not conf.get("loginHost") and raw.get("host"):
                conf["loginHost"] = raw["host"]
            if raw.get("port") and not raw.get("loginPort"):
                conf["loginPort"] = raw["port"]
    except (OSError, ValueError):
        pass
    conf["key"] = str(conf.get("key") or "") or key
    conf["loginPort"] = int(conf.get("loginPort") or 22)
    conf["relayPort"] = int(conf.get("relayPort") or 2222)
    return conf


def save_config(conf: dict) -> None:
    key = str(conf.get("key") or "")
    if not key:
        return
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    path = session_path(key)
    path.write_text(json.dumps(conf, indent=2, ensure_ascii=False) + "\n")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def remaining_ms(conf: dict) -> int:
    """Milliseconds left on this session, judged by when it was established."""
    started = int(conf.get("connectedAt") or 0)
    if not started:
        return 0
    return max(0, started + PERSIST_MS - int(time.time() * 1000))


def control_path(conf: dict) -> str:
    """The socket path, namespaced by session so sessions do not collide."""
    declared = str(conf.get("controlPath") or "").strip()
    if declared:
        expanded = pathlib.Path(os.path.expanduser(declared))
        expanded.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        return str(expanded)
    folder = CONF_DIR / "cm" / slug(str(conf.get("key") or ""))
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    return str(folder / "%r@%h-%p")


def control_opts(conf: dict) -> list[str]:
    return [
        "-o", "ControlMaster=auto",
        "-o", f"ControlPath={control_path(conf)}",
        "-o", f"ControlPersist={CONTROL_PERSIST}",
        # Keep the idle master from being reaped by NAT/VPN idle timers: without
        # this the socket can look alive while the TCP path is already gone.
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=6",
        "-o", "TCPKeepAlive=yes",
    ]


def gateway() -> str:
    try:
        return subprocess.run(
            ["sh", "-c", "ip route | awk '/^default/{print $3; exit}'"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def target(conf: dict) -> tuple[str, int]:
    if conf.get("mode") == "relay":
        host = conf.get("relayHost") or gateway()
        return host, int(conf.get("relayPort", 2222))
    return str(conf.get("loginHost")), int(conf.get("loginPort", 22))


def reachable(host: str, port: int, timeout: float = 5.0) -> bool:
    if not host:
        return False
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def ssh_base(conf: dict) -> list[str]:
    host, port = target(conf)
    args = ["ssh", "-o", f"HostName={host}", "-o", f"Port={port}"]
    user = str(conf.get("user") or "").strip()
    if user:
        args += ["-o", f"User={user}"]
    return args + control_opts(conf)


def master_alive(conf: dict) -> bool:
    host, _ = target(conf)
    if not host:
        return False
    try:
        r = subprocess.run(ssh_base(conf) + ["-O", "check", host],
                           capture_output=True, text=True, timeout=15)
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def status(conf: dict) -> dict:
    host, port = target(conf)
    base = {
        "ok": True,
        "key": conf.get("key", ""),
        "master": master_alive(conf),
        "mode": conf.get("mode"),
        "target": f"{host}:{port}",
        "reachable": reachable(host, port),
        "user": conf.get("user") or "",
    }
    base["remainingMs"] = remaining_ms(conf) if base["master"] else 0
    if not base["master"]:
        return base
    try:
        r = subprocess.run(ssh_base(conf) + [host, "hostname; whoami"],
                           capture_output=True, text=True, timeout=20)
        lines = [x for x in r.stdout.strip().splitlines() if x.strip()]
        base["host"] = lines[0] if lines else ""
        base["account"] = lines[1] if len(lines) > 1 else ""
    except Exception as exc:  # noqa: BLE001
        base["error"] = str(exc)
    return base


def status_all() -> dict:
    """One pass over every session: cheap enough to poll from the page."""
    sessions = []
    try:
        files = sorted(SESSIONS_DIR.glob("*.json"))
    except OSError:
        files = []
    for path in files:
        conf = load_config(path.stem)
        host, port = target(conf)
        sessions.append({
            "ok": True,
            "key": str(conf.get("key") or path.stem),
            "master": master_alive(conf),
            "mode": conf.get("mode"),
            "target": f"{host}:{port}",
            "reachable": reachable(host, port),
            "user": conf.get("user") or "",
            "remainingMs": remaining_ms(conf) if master_alive(conf) else 0,
        })
    return {"ok": True, "sessions": sessions}


def diagnose(conf: dict) -> dict:
    checks = []

    def add(name: str, ok: bool, detail: str, fix: str = "") -> None:
        checks.append({"check": name, "ok": ok, "detail": detail, "fix": "" if ok else fix})

    add("python", sys.version_info >= (3, 7),
        f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "install Python 3.7+")
    add("pty", hasattr(pty, "openpty"), "available", "this platform lacks a pty module")
    add("ssh binary", bool(shutil.which("ssh")), shutil.which("ssh") or "missing",
        "install an OpenSSH client")

    host, port = target(conf)
    ok = reachable(host, port)
    if conf.get("mode") == "relay":
        fix = ("make sure the campus VPN is connected; the plugin starts the relay itself "
               "(restart DSH if it is not running)")
    else:
        fix = "connect the campus VPN, or check the host name"
    add(f"endpoint {host}:{port}", ok, "reachable" if ok else "not reachable", fix)

    add("account id", bool(conf.get("user")), conf.get("user") or "not set",
        "enter your student/staff id in the plugin page")
    return {"ok": all(c["ok"] for c in checks), "mode": conf.get("mode"), "checks": checks}


def logout(conf: dict) -> dict:
    host, _ = target(conf)
    try:
        subprocess.run(ssh_base(conf) + ["-O", "exit", host],
                       capture_output=True, text=True, timeout=15)
    except Exception:  # noqa: BLE001
        pass
    conf["connectedAt"] = 0
    save_config(conf)
    return {"ok": True, "master": master_alive(conf)}


def _answer_prompts(cmd: str, password: str, otp: str, timeout: float = 90.0) -> tuple[bool, str, str]:
    """Run cmd under a pty and answer password / OTP prompts.

    pty.fork() rather than openpty() + Popen() matters: it makes the pty the
    child's controlling terminal, and OpenSSH only prints its password prompt
    when it can open /dev/tty. With a bare pty that is not a controlling
    terminal, ssh blocks silently and the prompt never arrives.

    Returns (ok, stage, detail). Never logs the answers.
    """
    pid, master = pty.fork()
    if pid == 0:  # child: exec the driver command on the pty
        try:
            os.execv("/bin/sh", ["/bin/sh", "-c", cmd])
        finally:  # pragma: no cover - exec never returns
            os._exit(127)

    buf = ""
    stage = "connect"
    sent_password = sent_otp = False
    reaped = False
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 0.4)
            if ready:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                buf = (buf + chunk.decode("utf-8", "ignore"))[-4000:]
                tail = buf.rstrip()[-160:]
                if DENIED.search(tail):
                    return False, stage, "authentication rejected"
                if not sent_password and PASSWORD_PROMPT.search(tail):
                    os.write(master, (password + "\n").encode())
                    sent_password = True
                    stage = "password"
                    buf = ""
                elif sent_password and not sent_otp and OTP_PROMPT.search(tail):
                    os.write(master, (otp + "\n").encode())
                    sent_otp = True
                    stage = "otp"
                    buf = ""
            done, _ = os.waitpid(pid, os.WNOHANG)
            if done:
                reaped = True
                # drain whatever is left, then stop
                while True:
                    ready, _, _ = select.select([master], [], [], 0.1)
                    if not ready:
                        break
                    try:
                        chunk = os.read(master, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    buf = (buf + chunk.decode("utf-8", "ignore"))[-4000:]
                break
        if not reaped:
            done, _ = os.waitpid(pid, os.WNOHANG)
            if not done:
                try:
                    os.kill(pid, 9)
                    os.waitpid(pid, 0)
                except OSError:
                    pass
        if not sent_password:
            # Surface what ssh said: a stale ~/.ssh/config entry or an
            # unreachable relay otherwise looks exactly like a bad password.
            detail = buf.strip().splitlines()[-1].strip() if buf.strip() else ""
            return False, "connect", "no password prompt seen" + (f": {detail}" if detail else "")
        if not sent_otp:
            return False, "password", "no verification-code prompt seen"
        return True, "done", ""
    finally:
        try:
            os.close(master)
        except OSError:
            pass

def login(conf: dict, password: str, otp: str) -> dict:
    user = str(conf.get("user") or "").strip()
    if not user:
        return {"ok": False, "stage": "config", "error": "account id is not set"}
    host, port = target(conf)
    if not host:
        return {"ok": False, "stage": "network", "error": "no default gateway inside WSL"}
    if master_alive(conf):
        if not conf.get("connectedAt"):
            conf["connectedAt"] = int(time.time() * 1000)
            save_config(conf)
        return {"ok": True, "master": True, "already": True, "target": f"{host}:{port}"}
    if not reachable(host, port):
        stage = "relay" if conf.get("mode") == "relay" else "network"
        return {"ok": False, "stage": stage, "target": f"{host}:{port}",
                "error": f"cannot reach {host}:{port} (VPN or relay not running?)"}

    ctrl = " ".join(control_opts(conf))
    cmd = ("exec ssh -M -N -f -o StrictHostKeyChecking=accept-new "
           f"-o ConnectTimeout=15 -o HostName={host} -o Port={port} -o User={user} "
           f"{ctrl} {host}")
    ok, stage, detail = _answer_prompts(cmd, password, otp)
    if not ok:
        return {"ok": False, "stage": stage, "error": detail}

    alive = master_alive(conf)
    if alive:
        conf["connectedAt"] = int(time.time() * 1000)
        save_config(conf)
    return {
        "ok": alive,
        "master": alive,
        "stage": "done" if alive else "post",
        "error": None if alive else "ssh exited before the multiplexed connection was up",
    }


def main() -> None:
    args = sys.argv[1:]
    key = session_key(args)
    conf = load_config(key)

    if "--status-all" in args:
        print(json.dumps(status_all(), ensure_ascii=False)); return
    if "--status" in args:
        print(json.dumps(status(conf), ensure_ascii=False)); return
    if "--diagnose" in args:
        print(json.dumps(diagnose(conf), ensure_ascii=False)); return
    if "--logout" in args:
        print(json.dumps(logout(conf), ensure_ascii=False)); return
    if "--user" in args:
        i = args.index("--user")
        value = (args[i + 1] if len(args) > i + 1 else "").strip()
        if not re.fullmatch(r"[0-9A-Za-z._-]{4,32}", value):
            print(json.dumps({"ok": False, "error": "invalid account id"}, ensure_ascii=False)); return
        conf["user"] = value
        save_config(conf)
        print(json.dumps({"ok": True, "key": conf.get("key", ""), "user": value}, ensure_ascii=False)); return

    password = sys.stdin.readline().rstrip("\r\n")
    otp = sys.stdin.readline().rstrip("\r\n")
    if not password:
        print(json.dumps({"ok": False, "error": "empty password"}, ensure_ascii=False)); return
    print(json.dumps(login(conf, password, otp), ensure_ascii=False))


if __name__ == "__main__":
    main()
