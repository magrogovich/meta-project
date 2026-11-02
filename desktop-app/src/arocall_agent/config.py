"""Config under XDG paths. Dirs 700. Never logs the session key."""
import json
import os
from pathlib import Path

DEFAULT_BACKEND_URL = "http://localhost:4000"

DEFAULTS = {
    "backend_url": DEFAULT_BACKEND_URL,
    "employee_name": "",
    "mic_source": "@DEFAULT_SOURCE@",
    "monitor_source": "@DEFAULT_MONITOR@",
    "capture_mode": "system",    # "system" (all computer sound) or "app" (one target app)
    "target_app": "",            # app name/binary to capture in "app" mode (e.g. "zoom", "chrome")
    "app_sink": "arocall_app",   # null sink the target app is routed through
    # Voice-activity call detection (see vad.py + README "How call detection works").
    "vad_aggressiveness": 2,     # 0-3; higher = stricter about what counts as speech
    "buffer_s": 10,              # rolling pre-roll window kept in memory while idle
    "min_speech_ms": 600,        # speech per stream inside the window required to start
    "end_silence_s": 20,         # both-silence seconds before a call ends
    "min_call_s": 5,             # shorter calls (after trimming) are discarded
    "max_queue_mb": 500,
    "heartbeat_sec": 60,
    "notify_calls": True,          # notify-send at call start/end
    "consent_accepted_at": "",
    "notice_text": "",
    "paused": False,
}


def _dirs():
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    data = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    cfg, dat = base / "arocall", data / "arocall"
    return cfg, dat


def config_dir() -> Path:
    d, _ = _dirs()
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    return d


def data_dir() -> Path:
    _, d = _dirs()
    (d / "queue").mkdir(mode=0o700, parents=True, exist_ok=True)
    (d / "logs").mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    return d


def config_path() -> Path:
    return config_dir() / "config.json"


def load() -> dict:
    cfg = dict(DEFAULTS)
    p = config_path()
    if p.exists():
        try:
            cfg.update(json.loads(p.read_text()))
        except json.JSONDecodeError:
            pass
    env = os.environ.get("AROCALL_BACKEND_URL")
    if env:
        cfg["backend_url"] = env
    return cfg


def save(patch: dict) -> dict:
    cfg = load()
    cfg.update(patch)
    p = config_path()
    p.write_text(json.dumps(cfg, indent=2))
    os.chmod(p, 0o600)
    return cfg
