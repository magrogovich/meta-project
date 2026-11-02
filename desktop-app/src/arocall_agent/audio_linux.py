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

# Null sink that a single target app's audio is routed through when the user
# picks "specific app" capture instead of whole-system sound.
APP_SINK = "arocall_app"


def app_monitor_source(sink: str = APP_SINK) -> str:
    return f"{sink}.monitor"


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


def list_apps() -> list:
    """Apps currently playing audio: [{index, app, binary, media, sink}].

    Parsed from `pactl list sink-inputs`. Empty when nothing is playing —
    the user can still type the app name manually (matched at runtime).
    """
    check_tools()
    try:
        text = _pactl("list", "sink-inputs")
    except RuntimeError:
        return []
    apps, cur = [], None
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("Sink Input #"):
            if cur:
                apps.append(cur)
            try:
                cur = {"index": int(line.split("#", 1)[1]), "app": "", "binary": "", "media": "", "sink": ""}
            except ValueError:
                cur = None
        elif cur is not None and line.startswith("Sink:"):
            cur["sink"] = line.split(":", 1)[1].strip().lstrip("#")
        elif cur is not None and "=" in line:
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"')
            if key == "application.name":
                cur["app"] = val
            elif key == "application.process.binary":
                cur["binary"] = val
            elif key == "media.name":
                cur["media"] = val
    if cur:
        apps.append(cur)
    return [a for a in apps if a["index"] != ""]


def _app_sink_loaded(sink: str = APP_SINK) -> bool:
    try:
        short = _pactl("list", "short", "sinks")
    except RuntimeError:
        return False
    return any(sink == parts[1] for line in short.splitlines() if len(parts := line.split("\t")) >= 2)


def _module_loaded(name: str, arg_substr: str) -> bool:
    """True when a module with a matching argument is already loaded."""
    try:
        short = _pactl("list", "short", "modules")
    except RuntimeError:
        return False
    for line in short.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[1] == name and arg_substr in parts[2]:
            return True
    return False


def _default_sink_name() -> str:
    try:
        sink = _pactl("get-default-sink").strip()
        if sink and not sink.startswith("@"):
            return sink
    except RuntimeError:
        pass
    return "@DEFAULT_SINK@"


def ensure_app_sink(sink: str = APP_SINK, loopback_sink: str | None = None) -> None:
    """Create the null sink the target app is routed through (idempotent).

    Also loops the sink back to the real output so the user keeps hearing
    the app — without the loopback, routing would mute it on the speakers.
    A missing loopback module only warns (recording still works).
    """
    check_tools()
    if not _app_sink_loaded(sink):
        out = subprocess.run(
            ["pactl", "load-module", "module-null-sink",
             f"sink_name={sink}", "sink_properties=device.description=ArocallApp"],
            capture_output=True, text=True, timeout=10)
        if out.returncode != 0:
            raise RuntimeError(f"could not create app capture sink: {out.stderr.strip()[:200]}")
    try:
        if not _module_loaded("module-loopback", f"source={sink}.monitor"):
            target = loopback_sink or _default_sink_name()
            out = subprocess.run(
                ["pactl", "load-module", "module-loopback",
                 f"source={sink}.monitor", f"sink={target}"],
                capture_output=True, text=True, timeout=10)
            if out.returncode != 0:
                log.warning("app loopback unavailable (%s): the routed app may be silent on the speakers",
                            out.stderr.strip()[:200])
    except RuntimeError as e:
        log.warning("app loopback unavailable (%s): the routed app may be silent on the speakers", e)


def _matches(app: dict, match: str) -> bool:
    m = (match or "").strip().lower()
    if not m:
        return False
    return m in (app.get("app") or "").lower() or m in (app.get("binary") or "").lower()


def route_app_audio(match: str, sink: str = APP_SINK) -> int:
    """Move every sink-input of the target app onto our null sink.

    Returns how many inputs were moved. Safe to call repeatedly (e.g. every
    few seconds): inputs already on the sink are skipped, and newly started
    streams from the same app get picked up.
    """
    if not (match or "").strip():
        return 0
    ensure_app_sink(sink)
    moved = 0
    for app in list_apps():
        if not _matches(app, match):
            continue
        if str(app.get("sink")) == sink:
            continue
        try:
            _pactl("move-sink-input", str(app["index"]), sink)
            moved += 1
        except RuntimeError as e:
            log.warning("could not route %s to %s: %s", app.get("app"), sink, e)
    return moved


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
