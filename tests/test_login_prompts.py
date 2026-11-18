#!/usr/bin/env python3
"""Regression tests for resources/login.py.

Both cases below used to be checked by hand against the live cluster:

* the prompt state machine in ``_answer_prompts`` — a re-prompted credential
  fails fast with the stage the user actually reached, a hung ssh is reported
  as a timeout, and a failure never turns the pty buffer (prompt text, an
  echoed answer) into the error string;
* the session-file contract — ``save_config`` merges into the file instead of
  rewriting it from ``DEFAULTS``, so the fields the plugin owns survive, and
  ``host`` is backfilled from ``loginHost`` for files written before it existed.

No network and no cluster: the driver answers a fake ``ssh`` placed on PATH.

Run with ``python3 tests/test_login_prompts.py``.
"""
from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import shutil
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
DRIVER = ROOT / "resources" / "login.py"

FAKE_SSH = """#!/bin/sh
mode="${FAKE_SSH_MODE:-ok}"
case "$mode" in
  refused)
    printf 'ssh: connect to host 127.0.0.1 port 2222: Connection refused\\r\\n'
    exit 255 ;;
  hang)
    exec sleep 30 ;;
  silent)
    exit 0 ;;
esac
printf 'Password: '
IFS= read -r pw
case "$mode" in
  retry-password)
    printf '\\r\\nPassword: '
    IFS= read -r pw2
    exit 255 ;;
esac
printf '\\r\\nVerification code: '
IFS= read -r otp
case "$mode" in
  retry-otp)
    printf '\\r\\nVerification code: '
    IFS= read -r o2
    exit 255 ;;
  denied)
    printf '\\r\\nPermission denied (publickey,password).\\r\\n'
    exit 255 ;;
  silent-fail)
    exit 255 ;;
  *)
    printf '\\r\\n'
    exit 0 ;;
esac
"""


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_driver(home: pathlib.Path):
    """Import the driver with HOME pointing into the sandbox.

    The module resolves ~/.pku-cluster at import time, so HOME has to move
    before the import, not after.
    """
    os.environ["HOME"] = str(home)
    spec = importlib.util.spec_from_file_location("login_driver", DRIVER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def call(driver, cmd: str, mode: str, timeout: float = 5.0):
    os.environ["FAKE_SSH_MODE"] = mode
    started = time.time()
    ok, stage, detail = driver._answer_prompts(cmd, "hunter2", "123456", timeout=timeout)
    return ok, stage, detail, time.time() - started


def prompts(driver, tmp: pathlib.Path) -> None:
    cmd = ("exec ssh -M -N -f -o HostName=127.0.0.1 -o Port=2222 -o User=alice "
           "-o ControlMaster=auto -o ControlPath=" + str(tmp / "cm.sock") + " 127.0.0.1")

    ok, stage, detail, _ = call(driver, cmd, "ok")
    check(ok is True and stage == "done" and detail == "",
          f"a successful login should report done, got {(ok, stage, detail)}")

    ok, stage, detail, elapsed = call(driver, cmd, "retry-password")
    check(ok is False and stage == "password" and "re-prompted" in detail,
          f"a refused password should fail at stage password, got {(ok, stage, detail)}")
    check(elapsed < 5.0, f"a refused password should not wait for the deadline ({elapsed:.1f}s)")

    ok, stage, detail, elapsed = call(driver, cmd, "retry-otp")
    check(ok is False and stage == "otp" and "re-prompted" in detail,
          f"a refused code should fail at stage otp, got {(ok, stage, detail)}")
    check(elapsed < 5.0, f"a refused code should not wait for the deadline ({elapsed:.1f}s)")

    ok, stage, detail, _ = call(driver, cmd, "denied")
    check(ok is False and stage == "otp" and detail == "authentication rejected",
          f"a denial after the code should report stage otp, got {(ok, stage, detail)}")

    # The pty echoes what we typed. Neither the answer nor the prompt may end up
    # in the message the page shows.
    ok, stage, detail, _ = call(driver, cmd, "silent-fail")
    check(ok is False and stage == "otp" and detail == "authentication rejected",
          f"a silent failure should report only the rejection, got {(ok, stage, detail)}")
    check("123456" not in detail and "hunter2" not in detail,
          f"the error string leaked an answer: {detail!r}")

    ok, stage, detail, _ = call(driver, cmd, "refused")
    check(ok is False and stage == "connect" and "Connection refused" in detail,
          f"ssh's own message should survive as detail, got {(ok, stage, detail)}")

    ok, stage, detail, elapsed = call(driver, cmd, "hang", timeout=0.3)
    check(ok is False and detail == "timed out waiting for ssh to finish",
          f"a hung ssh should report a timeout, got {(ok, stage, detail)}")
    check(elapsed < 5.0, f"the timeout should not be padded ({elapsed:.1f}s)")

    ok, stage, detail, _ = call(driver, cmd, "silent")
    check(ok is False and stage == "connect" and detail == "no password prompt seen",
          f"an ssh that exits without a prompt should say so, got {(ok, stage, detail)}")

    check(driver._last_message("Verification code: 123456\r\n") == "",
          "a prompt line must not become an error message")
    check(driver._last_message("Password: ") == "",
          "a bare prompt must not become an error message")
    check(driver._last_message("123456", ("123456",)) == "",
          "an echoed answer must not become an error message")
    check(driver._last_message("ssh: connect to host x port 22: refused\r\n") ==
          "ssh: connect to host x port 22: refused",
          "_last_message should keep ssh's own diagnostics")


def session_files(driver, tmp: pathlib.Path) -> None:
    sessions = driver.SESSIONS_DIR
    sessions.mkdir(parents=True, exist_ok=True)
    path = driver.session_path("wm1:login")
    path.write_text(json.dumps({
        "key": "wm1:login",
        "cluster": "wm1",
        "endpoint": "login",
        "label": "未名一号 · 登录节点",
        "host": "wm-login.pku.edu.cn",
        "port": 22,
        "user": "",
        "mode": "relay",
        "relayHost": "127.0.0.1",
        "relayPort": 2345,
        "controlPath": "",
        "connectedAt": 0,
    }, ensure_ascii=False), encoding="utf-8")

    conf = driver.load_config("wm1:login")
    conf["user"] = "alice"
    driver.save_config(conf)

    saved = json.loads(path.read_text(encoding="utf-8"))
    check(saved.get("label") == "未名一号 · 登录节点", "save_config dropped the label")
    check(saved.get("cluster") == "wm1", "save_config dropped the cluster")
    check(saved.get("relayHost") == "127.0.0.1", "save_config dropped the relay address")
    check(saved.get("relayPort") == 2345, "save_config dropped the relay port")
    check(saved.get("user") == "alice", "save_config did not store the account id")

    # A file written before `host` existed must get it back from loginHost.
    legacy = driver.session_path("wm1:data")
    legacy.write_text(json.dumps({
        "key": "wm1:data", "loginHost": "data.example", "loginPort": 22,
        "user": "alice", "mode": "direct", "controlPath": "",
    }), encoding="utf-8")
    conf = driver.load_config("wm1:data")
    check(conf.get("host") == "data.example", "host was not backfilled from loginHost")
    check(conf.get("loginPort") == 22, "loginPort was not read")


def main() -> int:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="pku-driver-"))
    try:
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        ssh = bin_dir / "ssh"
        ssh.write_text(FAKE_SSH, encoding="utf-8")
        ssh.chmod(0o755)
        os.environ["PATH"] = f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"

        driver = load_driver(tmp / "home")
        if not hasattr(driver.pty, "fork"):
            print("login driver: skipped (this platform has no pty.fork)")
            return 0
        prompts(driver, tmp)
        session_files(driver, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("login driver: prompts and session files OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
