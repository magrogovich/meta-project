"""System tray: pystray + Pillow generated icons. Falls back when no tray exists."""
import logging
import threading

log = logging.getLogger("arocall.tray")

# status -> (color, text)
STATUSES = {
    "unconfigured": ("gray", "Not configured - open Settings and paste a session key"),
    "idle": ("green", "Connected"),
    "recording": ("red", "Recording call"),
    "uploading": ("orange", "Uploading"),
    "error": ("red", "Error - see logs"),
}

_state = {"status": "unconfigured", "detail": ""}
_icon = None


def set_status(status: str, detail: str = ""):
    _state["status"] = status
    _state["detail"] = detail
    icon = _icon
    if icon is not None:
        try:
            icon.icon = _make_icon(status)
            icon.title = tooltip()
        except Exception as e:
            log.error("tray update failed: %s", e)


def tooltip() -> str:
    color, text = STATUSES.get(_state["status"], STATUSES["error"])
    d = f" - {_state['detail']}" if _state["detail"] else ""
    return f"Arocall agent: {text}{d}"


def _make_icon(status: str):
    try:
        from . import icons as icons_mod
        return icons_mod.make_status_icon(status)
    except Exception as e:
        log.error("brand icon failed, using fallback: %s", e)
    from PIL import Image, ImageDraw

    color, _ = STATUSES.get(status, STATUSES["error"])
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse([8, 8, 56, 56], fill=color)
    if status == "error":
        draw.line([20, 20, 44, 44], fill="white", width=6)
        draw.line([44, 20, 20, 44], fill="white", width=6)
    return img


def run_tray(callbacks: dict) -> bool:
    """Start the tray icon. Returns False when no tray is available."""
    try:
        import pystray
    except Exception as e:
        log.warning("tray unavailable (%s)", e)
        print("No system tray available (e.g. GNOME without the AppIndicator extension).")
        print("Use the terminal instead: `arocall-agent setup`, `arocall-agent status`, `arocall-agent run`.")
        return False
    try:
        from pystray import Menu, MenuItem

        def item(label, fn):
            return MenuItem(label, fn)

        menu = Menu(
            item("Open Settings", lambda: callbacks.get("settings", lambda: None)()),
            item("Status", lambda: callbacks.get("status", lambda: None)()),
            item("Pause recording", lambda: callbacks.get("pause", lambda: None)()),
            item("Resume recording", lambda: callbacks.get("resume", lambda: None)()),
            item("Quit", lambda icon, item: callbacks.get("quit", lambda: None)()),
        )
        global _icon
        _icon = pystray.Icon("arocall-agent", _make_icon(_state["status"]), tooltip(), menu)
        threading.Thread(target=_icon.run, daemon=True).start()
        return True
    except Exception as e:
        log.warning("tray failed to start (%s)", e)
        print("System tray could not start. Terminal fallback: `arocall-agent setup | status | run`.")
        return False


def stop_tray():
    global _icon
    if _icon is not None:
        try:
            _icon.stop()
        except Exception:
            pass
        _icon = None
