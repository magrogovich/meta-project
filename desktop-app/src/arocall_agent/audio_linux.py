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


def _tokens(text: str) -> set:
    import re
    return {t for t in re.split(r"[^a-z0-9]+", (text or "").lower()) if len(t) >= 3}


def _matches(app: dict, match: str) -> bool:
    m = (match or "").strip().lower()
    if not m:
        return False
    live = ((app.get("app") or "") + " " + (app.get("binary") or "")).lower()
    if m in live:
        return True
    # The installed binary is often longer than the runtime one
    # (e.g. "brave-browser-stable" vs "brave"): a shared token still matches.
    return bool(_tokens(m) & _tokens(live))


def live_binary_for(installed: dict, live: list) -> str:
    """Ground-truth runtime binary for an installed app, or "" when not playing.

    Prefer the observed sink-input identity over the Exec-derived guess, so a
    pick made while the app plays sound keeps working even when the two differ.
    """
    for s in live:
        if _matches(s, installed.get("binary") or "") or _matches(s, installed.get("name") or ""):
            return (s.get("binary") or s.get("app") or "").strip()
    return ""


# ---- installed apps (XDG desktop database) ------------------------------
# Names typed by hand are fragile (typos, wrong binary), so the picker offers
# the system's installed apps and stores the OS-derived binary. Runtime
# matching still uses _matches() against live sink-inputs.

def _desktop_dirs() -> list:
    import os
    from pathlib import Path

    dirs = [Path.home() / ".local" / "share" / "applications"]
    for base in os.environ.get("XDG_DATA_DIRS", "/usr/local/share:/usr/share").split(":"):
        if base.strip():
            dirs.append(Path(base.strip()) / "applications")
    return [d for d in dirs if d.is_dir()]


def _exec_binary(exec_line: str) -> str:
    """Best-effort binary for a .desktop Exec line (no typing involved)."""
    import os
    import shlex

    try:
        tokens = shlex.split(exec_line, posix=True)
    except ValueError:
        tokens = exec_line.split()
    # drop freedesktop field codes (%f %F %u %U %d %D %n %N %i %c %k %v %m)
    tokens = [t for t in tokens if not (t.startswith("%") and len(t) == 2)]
    # drop a leading `env` with VAR= assignments
    while tokens and (tokens[0] == "env" or "=" in tokens[0]):
        tokens.pop(0)
    if not tokens:
        return ""
    if os.path.basename(tokens[0]) == "flatpak":
        rest = [t for t in tokens[1:] if t != "run" and not t.startswith("-")]
        if rest:
            return rest[0].split(".")[-1].lower()
        return ""
    return os.path.basename(tokens[0]).lower()


def _parse_desktop_file(path) -> dict | None:
    import configparser

    cp = configparser.ConfigParser(interpolation=None)
    cp.optionxform = str
    try:
        cp.read(path, encoding="utf-8")
    except (configparser.Error, OSError):
        return None
    if "Desktop Entry" not in cp:
        return None
    e = cp["Desktop Entry"]
    if e.get("Type", "Application") != "Application":
        return None
    if e.get("NoDisplay", "false").lower() == "true" or e.get("Hidden", "false").lower() == "true":
        return None
    exec_line = (e.get("Exec") or "").strip()
    name = (e.get("Name") or "").strip()
    if not exec_line or not name:
        return None
    binary = _exec_binary(exec_line)
    if not binary:
        return None
    return {"name": name, "binary": binary, "exec": exec_line,
            "icon": (e.get("Icon") or "").strip(), "desktop_id": path.name}


def list_installed_apps() -> list:
    """Installed GUI apps: [{name, binary, icon, playing}]. No audio tools needed.

    `playing` marks apps with a live audio stream right now (needs pactl;
    False for all when the sound server is unreachable).
    """
    seen, apps = set(), []
    for d in _desktop_dirs():
        try:
            files = sorted(d.glob("*.desktop"))
        except OSError:
            continue
        for f in files:
            if f.name in seen:
                continue
            seen.add(f.name)
            parsed = _parse_desktop_file(f)
            if parsed:
                apps.append(parsed)
    try:
        live = list_apps()
    except RuntimeError:
        live = []
    for a in apps:
        a["live_binary"] = live_binary_for(a, live)
        a["playing"] = bool(a["live_binary"])
    apps.sort(key=lambda a: (not a["playing"], a["name"].lower()))
    return apps


def describe_live_apps() -> list:
    """Short labels of streams playing right now (for logs/UI).

    Nameless streams (no application.name/binary) are labeled with their
    index and media name instead of a bare "unknown", so a mismatch can
    actually be diagnosed.
    """
    try:
        live = list_apps()
    except RuntimeError:
        return []
    out = []
    for s in live:
        name = (s.get("app") or "").strip()
        binary = (s.get("binary") or "").strip()
        media = (s.get("media") or "").strip()
        if name and binary.lower() != name.lower():
            out.append(f"{name} ({binary})")
        elif name:
            out.append(name)
        else:
            out.append(f"stream #{s.get('index')}" + (f" [{media}]" if media else " [no name]"))
    return out


# Last (match, live-set) that produced a no-match warning, per sink: the
# re-route loop runs every 2 s, so only warn when something actually changed.
_nowarn_cache: dict = {}


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
    if moved == 0:
        live = describe_live_apps()
        sig = (match.strip().lower(), tuple(live))
        if _nowarn_cache.get(sink) != sig:
            _nowarn_cache[sink] = sig
            log.warning("no audio streams matched %r%s", match,
                        f" — playing right now: {', '.join(live)}" if live else " — nothing is playing right now")
    else:
        _nowarn_cache.pop(sink, None)  # a future mismatch warns again
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
