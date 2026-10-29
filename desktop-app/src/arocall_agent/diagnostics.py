"""Diagnostics bundle for support (never includes the session key or audio)."""
import platform
import shutil

from . import VERSION
from . import config as app_config
from . import autostart as autostart_mod


def collect() -> dict:
    cfg = app_config.load()
    qdir = app_config.data_dir() / "queue"
    pending = len(list(qdir.glob("*/meta.json"))) if qdir.exists() else 0
    return {
        "agent_version": VERSION,
        "backend_url": cfg.get("backend_url"),
        "employee": cfg.get("employee_name") or "(unknown)",
        "key_set": True,  # presence only, never the value
        "paused": bool(cfg.get("paused")),
        "queue_pending": pending,
        "last_upload_at": cfg.get("last_upload_at") or "never",
        "consent_accepted_at": cfg.get("consent_accepted_at") or "no",
        "autostart": autostart_mod.is_enabled(),
        "os": f"{platform.system()} {platform.release()}",
        "tools": {t: shutil.which(t) is not None for t in ("ffmpeg", "pactl", "parec", "notify-send")},
    }


def format_text(d: dict) -> str:
    lines = [f"{k}: {v}" for k, v in d.items() if k != "tools"]
    lines.append("tools: " + ", ".join(f"{k}={'ok' if v else 'MISSING'}" for k, v in d["tools"].items()))
    return "\n".join(lines)
