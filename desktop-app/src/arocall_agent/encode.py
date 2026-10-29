"""WAV (16kHz mono s16le) -> Opus (.ogg) via system ffmpeg."""
import logging
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("arocall.encode")


def check_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is missing — install it (e.g. `sudo apt install ffmpeg`).")


def to_opus(wav_path: Path, out_path: Path, bitrate: str = "24k") -> Path:
    check_ffmpeg()
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(wav_path),
         "-c:a", "libopus", "-b:a", bitrate, "-ac", "1", "-ar", "16000", str(out_path)],
        capture_output=True, text=True, timeout=300,
    )
    if r.returncode != 0 or not out_path.exists():
        raise RuntimeError(f"ffmpeg encode failed: {r.stderr.strip()[:200]}")
    log.info("encoded %s -> %s (%d bytes)", wav_path.name, out_path.name, out_path.stat().st_size)
    return out_path
