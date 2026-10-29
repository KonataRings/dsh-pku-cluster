#!/usr/bin/env python3
"""PKU cluster login driver (stdlib only).

Reads ~/.pku-cluster/config.json and establishes an SSH ControlMaster
connection using a password + OTP (the cluster offers no key auth).
No third-party packages: the password/OTP prompts are answered through a
pseudo-terminal opened with the standard `pty` module.

Modes:
  relay  - Windows hosts: ssh connects to a loopback relay on the WSL host
           gateway, because WSL does not inherit the Windows VPN.
  direct - Linux/macOS: ssh connects straight to the login node.

Usage:
  login.py --status          connection state (JSON)
  login.py --logout          drop the ControlMaster
  login.py --user <id>       store the account id
  login.py --diagnose        environment checks (JSON)
  login.py --login           read password + OTP from stdin, then connect
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
CONF_FILE = CONF_DIR / "config.json"

DEFAULTS = {
    "mode": "direct",
    "loginHost": "wmjx2-login.pku.edu.cn",
    "loginPort": 22,
    "relayHost": "",  # empty = derive from the default gateway
    "relayPort": 2222,
    "user": "",
}

PASSWORD_PROMPT = re.compile(r"(?i)password\s*:?\s*$")
OTP_PROMPT = re.compile(r"(?i)verification\s+code\s*:?\s*$")
DENIED = re.compile(r"(?i)permission\s+denied|authentication\s+failed")

# ControlMaster needs an explicit socket path: this plugin never writes
# ~/.ssh/config, so relying on a user-supplied default would be wrong.
CONTROL_DIR = CONF_DIR / "cm"
CONTROL_PERSIST = "8h"


def control_opts() -> list[str]:
    CONTROL_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    return [
        "-o", "ControlMaster=auto",
        "-o", f"ControlPath={CONTROL_DIR}/%r@%h-%p",
        "-o", f"ControlPersist={CONTROL_PERSIST}",
        # Keep the idle master from being reaped by NAT/VPN idle timers: without
        # this the socket can look alive while the TCP path is already gone.
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=6",
        "-o", "TCPKeepAlive=yes",
    ]


def load_config() -> dict:
    conf = dict(DEFAULTS)
    try:
        raw = json.loads(CONF_FILE.read_text())
        if isinstance(raw, dict):
            for key in DEFAULTS:
                if key in raw:
                    conf[key] = raw[key]
    except (OSError, ValueError):
        pass
    return conf


def save_config(conf: dict) -> None:
    CONF_DIR.mkdir(parents=True, exist_ok=True)
    CONF_FILE.write_text(json.dumps(conf, indent=2, ensure_ascii=False) + "\n")
    CONF_FILE.chmod(0o600)


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
    return args + control_opts()


def master_alive(conf: dict) -> bool:
    host, _ = target(conf)
    if not host:
        return False
    try:
        r = subprocess.run(ssh_base(conf) + ["-O", "check", "pku"],
                           capture_output=True, text=True, timeout=15)
        return r.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def status(conf: dict) -> dict:
    host, port = target(conf)
    base = {
        "ok": True,
        "master": master_alive(conf),
        "mode": conf.get("mode"),
        "target": f"{host}:{port}",
        "reachable": reachable(host, port),
        "user": conf.get("user") or "",
    }
    if not base["master"]:
        return base
    try:
        r = subprocess.run(ssh_base(conf) + ["pku", "hostname; whoami"],
                           capture_output=True, text=True, timeout=20)
        lines = [x for x in r.stdout.strip().splitlines() if x.strip()]
        base["host"] = lines[0] if lines else ""
        base["account"] = lines[1] if len(lines) > 1 else ""
    except Exception as exc:  # noqa: BLE001
        base["error"] = str(exc)
    return base


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
        fix = "connect the campus VPN, or check the login host name"
    add(f"endpoint {host}:{port}", ok, "reachable" if ok else "not reachable", fix)

    add("account id", bool(conf.get("user")), conf.get("user") or "not set",
        "enter your student/staff id in the plugin page")
    return {"ok": all(c["ok"] for c in checks), "mode": conf.get("mode"), "checks": checks}


def logout(conf: dict) -> dict:
    try:
        subprocess.run(ssh_base(conf) + ["-O", "exit", "pku"],
                       capture_output=True, text=True, timeout=15)
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "master": master_alive(conf)}


def _answer_prompts(cmd: str, password: str, otp: str, timeout: float = 90.0) -> tuple[bool, str, str]:
    """Run cmd under a pty and answer password / OTP prompts.

    Returns (ok, stage, detail). Never logs the answers.
    """
    master, slave = pty.openpty()
    try:
        proc = subprocess.Popen(["/bin/sh", "-c", cmd], stdin=slave, stdout=slave,
                                stderr=slave, close_fds=True)
    finally:
        os.close(slave)

    buf = ""
    stage = "connect"
    sent_password = sent_otp = False
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
            if proc.poll() is not None:
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
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        if not sent_password:
            return False, "connect", "no password prompt seen"
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
        return {"ok": True, "master": True, "already": True, "target": f"{host}:{port}"}
    if not reachable(host, port):
        stage = "relay" if conf.get("mode") == "relay" else "network"
        return {"ok": False, "stage": stage, "target": f"{host}:{port}",
                "error": f"cannot reach {host}:{port} (VPN or relay not running?)"}

    ctrl = " ".join(control_opts())
    cmd = ("exec ssh -M -N -f -o StrictHostKeyChecking=accept-new "
           f"-o ConnectTimeout=15 -o HostName={host} -o Port={port} -o User={user} "
           f"{ctrl} pku")
    ok, stage, detail = _answer_prompts(cmd, password, otp)
    if not ok:
        return {"ok": False, "stage": stage, "error": detail}

    alive = master_alive(conf)
    return {
        "ok": alive,
        "master": alive,
        "stage": "done" if alive else "post",
        "error": None if alive else "ssh exited before the multiplexed connection was up",
    }


def main() -> None:
    args = sys.argv[1:]
    conf = load_config()

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
        print(json.dumps({"ok": True, "user": value}, ensure_ascii=False)); return

    password = sys.stdin.readline().rstrip("\r\n")
    otp = sys.stdin.readline().rstrip("\r\n")
    if not password:
        print(json.dumps({"ok": False, "error": "empty password"}, ensure_ascii=False)); return
    print(json.dumps(login(conf, password, otp), ensure_ascii=False))


if __name__ == "__main__":
    main()
