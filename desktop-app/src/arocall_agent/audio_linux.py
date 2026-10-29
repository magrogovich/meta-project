"""Linux audio capture via PulseAudio/PipeWire CLI tools (parec/pactl).

Only this module (plus autostart) is platform-specific; the recorder, detector,
queue and UI talk to the small interface below so Windows/macOS can be added later.
"""
import logging
import shutil
import subprocess
import threading

log = logging.getLogger("arocall.audio_linux")

RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH = 2  # s16le


def check_tools() -> None:
    missing = [t for t in ("pactl", "parec") if shutil.which(t) is None]
    if missing:
        raise RuntimeError(
            f"missing audio tools: {', '.join(missing)}. "
            "Install PipeWire/PulseAudio utilities (e.g. `sudo apt install pulseaudio-utils`)."
        )


def _pactl(*args: str) -> str:
    out = subprocess.run(["pactl", *args], capture_output=True, text=True, timeout=10)
    if out.returncode != 0:
        raise RuntimeError(f"pactl {' '.join(args)} failed: {out.stderr.strip()[:200]}")
    return out.stdout


def list_sources() -> dict:
    """Returns {inputs: [{name, desc}], monitors: [...], default_input, default_monitor}."""
    check_tools()
    inputs, monitors = [], []
    for line in _pactl("list", "short", "sources").splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        name = parts[1]
        desc = name
        if name.endswith(".monitor"):
            monitors.append({"name": name, "desc": f"{name} (system sound)"})
        else:
            inputs.append({"name": name, "desc": name})
    try:
        default_input = _pactl("get-default-source").strip() or "@DEFAULT_SOURCE@"
    except RuntimeError:
        default_input = "@DEFAULT_SOURCE@"
    try:
        sink = _pactl("get-default-sink").strip()
        default_monitor = (sink + ".monitor") if sink and not sink.startswith("@") else "@DEFAULT_MONITOR@"
    except RuntimeError:
        default_monitor = "@DEFAULT_MONITOR@"
    if not any(m["name"] == default_monitor for m in monitors):
        monitors.insert(0, {"name": default_monitor, "desc": f"{default_monitor} (system sound)"})
    return {"inputs": inputs, "monitors": monitors,
            "default_input": default_input, "default_monitor": default_monitor}


def rms_level(pcm: bytes) -> float:
    """RMS energy 0.0..~1.0 for s16le mono frames."""
    import numpy as np

    if not pcm:
        return 0.0
    a = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    return float((a * a).mean() ** 0.5)


class Stream:
    """Raw PCM reader around a `parec` subprocess. Restarts itself (watchdog)."""

    def __init__(self, source: str, rate: int = RATE, on_death=None):
        self.source = source
        self.rate = rate
        self.on_death = on_death
        self.proc = None
        self._lock = threading.Lock()
        self.start()

    def start(self):
        check_tools()
        with self._lock:
            self.stop_locked()
            self.proc = subprocess.Popen(
                ["parec", "--format=s16le", f"--rate={self.rate}",
                 "--channels=1", "-d", self.source, "--latency-msec=50"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
            log.info("capture started: %s", self.source)

    def stop_locked(self):
        if self.proc is not None:
            try:
                self.proc.kill()
                self.proc.wait(timeout=2)
            except Exception:
                pass
            self.proc = None

    def stop(self):
        with self._lock:
            self.stop_locked()

    def read(self, nbytes: int) -> bytes:
        """Read exactly nbytes (blocks). Auto-restarts a dead subprocess (watchdog)."""
        with self._lock:
            proc = self.proc
        if proc is None or proc.poll() is not None:
            log.error("capture subprocess died for %s — restarting", self.source)
            if self.on_death:
                self.on_death(self.source)
            self.start()
            with self._lock:
                proc = self.proc
        data = b""
        while len(data) < nbytes:
            chunk = proc.stdout.read(nbytes - len(data))
            if not chunk:
                log.error("capture stream EOF for %s — restarting", self.source)
                if self.on_death:
                    self.on_death(self.source)
                self.start()
                with self._lock:
                    proc = self.proc
                continue
            data += chunk
        return data
