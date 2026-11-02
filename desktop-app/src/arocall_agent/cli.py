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
    _setup_audio_source(cfg)
    return 0


def _setup_audio_source(cfg: dict):
    """Choose whole-system sound vs one specific app (terminal setup)."""
    from . import audio as audio_shim
    try:
        mod = audio_shim.load()
    except NotImplementedError as e:
        print(f"Audio setup skipped: {e}")
        return
    print("\nCustomer audio: record everything the computer plays, or just one app?")
    print("  [1] Entire system sound (default)")
    print("  [2] One specific app (e.g. your softphone, browser, meeting app)")
    choice = input("Choose [1/2] (Enter = 1): ").strip()
    if choice != "2":
        app_config.save({"capture_mode": "system", "target_app": ""})
        print("Capturing entire system sound.")
        return
    print("Only apps playing sound right now can be listed — start a call or play audio in the app first.")
    match = ""
    while not match:
        try:
            apps = mod.list_apps()
        except RuntimeError as e:
            print(f"Could not list apps ({e}).")
            apps = []
        if apps:
            print("Apps currently playing sound:")
            for i, a in enumerate(apps, 1):
                name = a.get("app") or a.get("binary") or "unknown"
                media = f" ({a['media']})" if a.get("media") else ""
                print(f"  [{i}] {name}{media}")
        else:
            print("No apps are playing sound right now.")
            print("  Tip: play audio in the app, then rescan. To see exact names yourself, run")
            print("  this while the app plays sound:")
            print("    pactl list sink-inputs | grep -E 'application.name|application.process.binary'")
        raw = input("Pick a number, type the app name, [r]escan, or empty for entire system sound: ").strip()
        if not raw:
            break
        if raw.lower() in ("r", "refresh", "rescan"):
            continue
        if raw.isdigit() and apps and 1 <= int(raw) <= len(apps):
            a = apps[int(raw) - 1]
            match = (a.get("binary") or a.get("app") or "").strip()
            if not match:
                print("That entry has no usable name — type the app name manually.")
                continue
        elif raw.isdigit():
            print(f"No app #{raw} — pick 1-{len(apps)}, type a name, or rescan.")
            continue
        else:
            match = raw
    if not match:
        print("Keeping entire system sound.")
        app_config.save({"capture_mode": "system", "target_app": ""})
        return
    app_config.save({"capture_mode": "app", "target_app": match})
    print(f"Capturing only '{match}'. Start a call in that app so the agent can route its sound.")


def cmd_status(_args):
    cfg = app_config.load()
    has_key = bool(keystore.load_key())
    print(f"{APP_NAME} {VERSION}")
    print(f"backend: {cfg['backend_url']}")
    print(f"employee: {cfg.get('employee_name') or '(unknown)'}")
    print(f"key: {'set' if has_key else 'MISSING — run setup'}")
    print(f"paused: {cfg.get('paused')}")
    if cfg.get("capture_mode") == "app" and cfg.get("target_app"):
        print(f"capture: app '{cfg['target_app']}' only")
    else:
        print("capture: entire system sound")
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


def cmd_monitor(_args):
    """Live VAD tuning view: state, per-stream speech, window speech, silence.

    Reads the real mic + system/app streams but never records or uploads.
    """
    import time
    from . import audio as audio_shim
    from .vad import CallStateMachine, FRAME_BYTES
    cfg = app_config.load()
    try:
        mod = audio_shim.load()
    except NotImplementedError as e:
        print(f"Monitor unavailable: {e}")
        return 1
    try:
        import webrtcvad  # noqa: F401
    except ImportError:
        print("ERROR: webrtcvad is not installed — run `pip install webrtcvad-wheels`, then retry.")
        return 1
    monitor_source = cfg["monitor_source"]
    if cfg.get("capture_mode") == "app" and (cfg.get("target_app") or "").strip():
        try:
            from .audio_linux import APP_SINK, app_monitor_source, route_app_audio
            sink = cfg.get("app_sink") or APP_SINK
            route_app_audio(cfg["target_app"], sink)
            monitor_source = app_monitor_source(sink)
        except RuntimeError as e:
            print(f"Note: app routing failed ({e}) — watching system sound instead.")
    sm = CallStateMachine(
        aggressiveness=cfg["vad_aggressiveness"], buffer_s=cfg["buffer_s"],
        min_speech_ms=cfg["min_speech_ms"], end_silence_s=cfg["end_silence_s"],
        min_call_s=cfg["min_call_s"])
    ms = mod.Stream(cfg["mic_source"])
    ns = mod.Stream(monitor_source)
    print(f"monitoring mic={cfg['mic_source']} monitor={monitor_source} "
          f"(aggressiveness={cfg['vad_aggressiveness']}). Ctrl+C to stop. Nothing is recorded.")
    print(f"{'state':<10} {'mic':<5} {'sys':<5} {'mic_win_ms':>10} {'sys_win_ms':>10} {'silence_s':>9}")
    pending_ack = False
    last = 0.0
    try:
        while True:
            mic_pcm = ms.read(FRAME_BYTES)
            sys_pcm = ns.read(FRAME_BYTES)
            ev, _ = sm.feed(mic_pcm, sys_pcm)
            if ev == "started":
                print("--> call started: both sides active")
            elif ev in ("ended", "discarded"):
                print(f"--> call {ev}")
                pending_ack = True
            now = time.time()
            if now - last >= 1.0:
                last = now
                s = sm.snapshot()
                print(f"{s['state']:<10} {str(s['mic_speech']):<5} {str(s['sys_speech']):<5} "
                      f"{s['mic_window_ms']:>10} {s['sys_window_ms']:>10} {s['silence_s']:>9.1f}",
                      flush=True)
                if pending_ack:
                    sm.acknowledge()
                    pending_ack = False
    except KeyboardInterrupt:
        pass
    finally:
        ms.stop()
        ns.stop()
    return 0


def main(argv=None):
    setup_logging()
    ap = argparse.ArgumentParser(prog=APP_NAME, description="Arocall Linux call-recording agent")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup", help="paste session key and connect")
    sub.add_parser("status", help="show status, queue size, backend")
    sub.add_parser("run", help="start background agent (tray + loop)")
    sub.add_parser("audio", help="choose whole-system sound vs one specific app")
    sub.add_parser("monitor", help="live VAD view for tuning (records nothing)")
    auto = sub.add_parser("autostart", help="enable/disable login autostart")
    auto.add_argument("state", choices=["on", "off"])
    args = ap.parse_args(argv)
    if args.cmd == "setup":
        return cmd_setup(args)
    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "audio":
        _setup_audio_source(app_config.load())
        return 0
    if args.cmd == "monitor":
        return cmd_monitor(args)
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
