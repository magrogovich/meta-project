"""Platform shim: only audio_linux (capture) and autostart are OS-specific,
so Windows/macOS later means adding audio_windows.py / audio_macos.py here."""
import sys


def load():
    if sys.platform.startswith("linux"):
        from . import audio_linux as mod
        return mod
    raise NotImplementedError(
        f"audio capture is Linux-only for now (running on {sys.platform}). "
        "See README: how to extend to Windows/macOS."
    )
