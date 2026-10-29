"""Terminal fallback + entry point: setup | status | run. Plus single-instance lock."""
import argparse
import fcntl
import getpass
import logging
import os
import sys
import time

from . import APP_NAME, VERSION
from . import config as app_config
from . import keystore
from . import api as backend
from . import settings_ui
from . import tray as tray_mod

log = logging.getLogger("arocall")


def setup_logging():
    d = app_config.data_dir() / "logs"
    from logging.handlers import RotatingFileHandler

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fh = RotatingFileHandler(d / "agent.log", maxBytes=1_000_000, backupCount=3)
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root.addHandler(fh)
    ch = logging.StreamHandler()
    ch.setFormatter(logging.Formatter("%(message)s"))
    root.addHandler(ch)


class SingleInstance:
    def __init__(self):
        self.fp = None
        self.path = app_config.data_dir() / "agent.lock"

    def acquire(self) -> bool:
        self.fp = open(self.path, "w")
        try:
            fcntl.flock(self.fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.fp.write(str(os.getpid()))
            self.fp.flush()
            return True
        except OSError:
            return False


def cmd_setup(_args):
    print("=== Arocall agent setup ===")
    print("Calls handled on this computer will be recorded and analyzed by your employer.")
    print("The tray icon is always visible while the agent runs (never hidden).")
    cfg = app_config.load()
    if cfg.get("notice_text"):
        print(f"Notice from your company: {cfg['notice_text']}")
    if not cfg.get("consent_accepted_at"):
        print("You must accept call recording to continue.")
        ans = input("Type YES to accept that calls on this computer are recorded: ").strip()
        if ans != "YES":
            print("Consent not given. Setup aborted.")
            return 1
        from datetime import datetime, timezone
        app_config.save({"consent_accepted_at": datetime.now(timezone.utc).isoformat()})
    key = getpass.getpass("Paste session key (find it in the dashboard: Employees > profile > Agent tab): ").strip()
    if not key:
        print("No key entered.")
        return 1
    try:
        emp = backend.validate_key(cfg["backend_url"], key)
    except backend.ApiError as e:
        print(f"Key check failed: {e}")
        return 1
    where = keystore.save_key(key)
    app_config.save({"employee_name": emp["name"]})
    tray_mod.set_status("idle", f"Connected as {emp['name']}")
    print(f"Connected as {emp['name']}. Key stored via {where}.")
    if where == "file":
        print("Note: OS keyring unavailable, key saved to a file with permissions 600.")
    return 0


def cmd_status(_args):
    cfg = app_config.load()
    has_key = bool(keystore.load_key())
    print(f"{APP_NAME} {VERSION}")
    print(f"backend: {cfg['backend_url']}")
    print(f"employee: {cfg.get('employee_name') or '(unknown)'}")
    print(f"key: {'set' if has_key else 'MISSING — run setup'}")
    print(f"paused: {cfg.get('paused')}")
    qdir = app_config.data_dir() / "queue"
    pending = len(list(qdir.glob("*.json"))) if qdir.exists() else 0
    print(f"queued calls: {pending}")
    return 0


def notify_send(title: str, body: str):
    cfg = app_config.load()
    if not cfg.get("notify_calls"):
        return
    import shutil
    import subprocess
    if shutil.which("notify-send"):
        try:
            subprocess.run(["notify-send", title, body], timeout=5, check=False)
        except Exception:
            pass


def cmd_run(_args):
    lock = SingleInstance()
    if not lock.acquire():
        print("Another arocall-agent is already running.")
        return 1
    cfg = app_config.load()
    key = keystore.load_key()
    if not key:
        print("No session key. Run `arocall-agent setup` first.")
        return 1
    try:
        emp = backend.validate_key(cfg["backend_url"], key)
        app_config.save({"employee_name": emp["name"]})
        status, detail = "idle", f"Connected as {emp['name']}"
    except backend.ApiError as e:
        status, detail = ("error", str(e)) if getattr(e, "revoked", False) else ("unconfigured", str(e))
        print(f"Warning: {e}")
    tray_mod.set_status(status, detail if status != "idle" else detail)
    print(f"arocall-agent {VERSION} running (tray + background loop). Press Ctrl+C to stop.")
    tray_ok = tray_mod.run_tray({
        "settings": lambda: settings_ui.open_settings(),
        "status": lambda: print("status: see `arocall-agent status`"),
        "pause": lambda: app_config.save({"paused": True}),
        "resume": lambda: app_config.save({"paused": False}),
        "quit": lambda: sys.exit(0),
    })
    if not tray_ok:
        print("Running headless — use `arocall-agent status` to inspect.")
    from .runner import Runner
    runner = Runner(cfg, keystore.load_key, tray_mod.set_status, notify_send)
    import threading
    t = threading.Thread(target=runner.run, daemon=True)
    t.start()
    try:
        while t.is_alive():
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        runner.stop()
        tray_mod.stop_tray()
    return 0


def main(argv=None):
    setup_logging()
    ap = argparse.ArgumentParser(prog=APP_NAME, description="Arocall Linux call-recording agent")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup", help="paste session key and connect")
    sub.add_parser("status", help="show status, queue size, backend")
    sub.add_parser("run", help="start background agent (tray + loop)")
    auto = sub.add_parser("autostart", help="enable/disable login autostart")
    auto.add_argument("state", choices=["on", "off"])
    args = ap.parse_args(argv)
    if args.cmd == "setup":
        return cmd_setup(args)
    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "autostart":
        from . import autostart as autostart_mod
        import shutil
        if args.state == "on":
            exe = shutil.which("arocall-agent") or "arocall-agent"
            p = autostart_mod.enable(exe)
            print(f"Autostart enabled: {p}")
        else:
            print("Autostart disabled." if autostart_mod.disable() else "Autostart was not enabled.")
        return 0
    return cmd_run(args)


if __name__ == "__main__":
    sys.exit(main())
