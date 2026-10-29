"""Session-key storage: OS keyring (Secret Service), else a 600-permission file.
The key is never printed or logged anywhere in this codebase."""
import os
from pathlib import Path

from . import config as app_config

SERVICE = "arocall-agent"
ACCOUNT = "session-key"


def _fallback_path() -> Path:
    return app_config.config_dir() / ".session-key"


def _keyring():
    try:
        import keyring
        keyring.get_keyring()
        return keyring
    except Exception:
        return None


def keyring_available() -> bool:
    kr = _keyring()
    if kr is None:
        return False
    try:
        kr.set_password(SERVICE, "__probe__", "x")
        kr.delete_password(SERVICE, "__probe__")
        return True
    except Exception:
        return False


def save_key(key: str) -> str:
    """Returns 'keyring' or 'file' depending on backend used."""
    kr = _keyring()
    if kr is not None:
        try:
            kr.set_password(SERVICE, ACCOUNT, key)
            return "keyring"
        except Exception:
            pass
    p = _fallback_path()
    p.write_text(key)
    os.chmod(p, 0o600)
    return "file"


def load_key() -> str:
    kr = _keyring()
    if kr is not None:
        try:
            v = kr.get_password(SERVICE, ACCOUNT)
            if v:
                return v
        except Exception:
            pass
    p = _fallback_path()
    return p.read_text().strip() if p.exists() else ""


def clear_key() -> None:
    kr = _keyring()
    if kr is not None:
        try:
            kr.delete_password(SERVICE, ACCOUNT)
        except Exception:
            pass
    p = _fallback_path()
    if p.exists():
        p.unlink()
