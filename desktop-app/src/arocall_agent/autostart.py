"""Login autostart via XDG .desktop file. Linux-only (Windows/macOS: task scheduler)."""
import os
from pathlib import Path

DESKTOP_FILE = """[Desktop Entry]
Type=Application
Name=Arocall agent
Comment=Record work calls and upload them to Arocall
Exec={exe} run
Icon={icon}
Terminal=false
Categories=Utility;
XDG_CURRENT_DESKTOP={desktops}
"""

APP_ID = "arocall-agent.desktop"
ICON_NAME = "arocall-agent.png"


def installed_icon() -> str:
    """Absolute path of the installed brand icon, or a stock fallback name."""
    from pathlib import Path as _P

    candidates = [
        _P.home() / ".local/share/icons/hicolor/256x256/apps" / ICON_NAME,
        _P("/usr/share/icons/hicolor/256x256/apps") / ICON_NAME,
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    try:
        from .icons import icon_path as _brand
        p = _brand()
        if p.is_file():
            return str(p)
    except Exception:
        pass
    return "audio-input-microphone"


def autostart_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))
    d = Path(base) / "autostart"
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    return d


def desktop_path() -> Path:
    return autostart_dir() / APP_ID


def enable(exe: str = "arocall-agent") -> Path:
    p = desktop_path()
    p.write_text(DESKTOP_FILE.format(exe=exe, icon=installed_icon(), desktops="GNOME;KDE;XFCE;"))
    os.chmod(p, 0o600)
    return p


def disable() -> bool:
    p = desktop_path()
    if p.exists():
        p.unlink()
        return True
    return False


def is_enabled() -> bool:
    return desktop_path().exists()
