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
    "energy_threshold": 0.02,      # RMS threshold on system stream to start a call
    "hangover_sec": 1.0,           # speech must persist this long to trigger
    "preroll_sec": 2.0,            # audio kept before trigger so call start isn't cut
    "silence_timeout_sec": 20.0,   # call ends after this much system silence
    "min_call_sec": 5.0,           # shorter "calls" are discarded
    "require_mic_activity": False, # also require mic energy before starting
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
