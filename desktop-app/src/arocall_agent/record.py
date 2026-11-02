"""Two-track call recorder: streams mic + system audio to disk during a call,
then writes Opus-ready WAVs plus a metadata JSON. Never holds a call in RAM."""
import time
import uuid
import wave
from dataclasses import dataclass
from pathlib import Path

from . import APP_NAME, VERSION


@dataclass
class CallFiles:
    call_id: str
    agent_wav: Path      # microphone
    customer_wav: Path   # system output
    meta_path: Path
    duration_sec: float


class CallRecorder:
    def __init__(self, calls_dir: Path, rate: int = 16000):
        self.calls_dir = Path(calls_dir)
        self.calls_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.rate = rate
        self.active = None  # dict while recording

    def start(self, mic_source: str, monitor_source: str, preroll=None) -> str:
        call_id = uuid4hex()
        d = self.calls_dir / call_id
        d.mkdir(mode=0o700, parents=True, exist_ok=True)
        agent = wave.open(str(d / "agent.wav"), "wb")
        customer = wave.open(str(d / "customer.wav"), "wb")
        for w in (agent, customer):
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self.rate)
        now = time.time()
        self.active = {
            "call_id": call_id, "dir": d, "agent": agent, "customer": customer,
            "mic_source": mic_source, "monitor_source": monitor_source,
            "start_wall": now, "frames": 0,
            # shared start timestamp; per-stream offsets (0.0 = in sync)
            "agent_offset_sec": 0.0, "customer_offset_sec": 0.0,
        }
        # preroll: list of (mic_pcm, sys_pcm) raw frames (VAD pre-roll dump)
        for mic_pcm, sys_pcm in preroll or []:
            self.write_frame(sys_pcm, mic_pcm)
        return call_id

    def write_frame(self, sys_pcm: bytes, mic_pcm: bytes):
        if not self.active:
            return
        # NOTE: agent track = microphone, customer track = system output
        self.active["agent"].writeframes(mic_pcm)
        self.active["customer"].writeframes(sys_pcm)
        self.active["frames"] += 1

    def abort(self):
        """Discard a too-short call: close files and remove the directory."""
        st = self.active
        self.active = None
        if not st:
            return
        try:
            st["agent"].close()
            st["customer"].close()
        except Exception:
            pass
        import shutil
        shutil.rmtree(st["dir"], ignore_errors=True)

    def finish(self, drop_trailing_frames: int = 0) -> CallFiles | None:
        """Close the call, trimming trailing silence (in 30 ms VAD frames).

        Duration is measured from the kept audio frames, not the wall clock.
        """
        st = self.active
        self.active = None
        if not st:
            return None
        st["agent"].close()
        st["customer"].close()
        import json

        if drop_trailing_frames > 0:
            drop_wave = drop_trailing_frames * VAD_FRAME_SAMPLES
            _trim_wav_tail(st["dir"] / "agent.wav", drop_wave)
            _trim_wav_tail(st["dir"] / "customer.wav", drop_wave)
        duration = _wav_duration(st["dir"] / "agent.wav", self.rate)
        meta = {
            "call_id": st["call_id"],
            "agent_app": APP_NAME,
            "agent_version": VERSION,
            "sample_rate": self.rate,
            "channels": 1,
            "sample_width": 2,
            "mic_source": st["mic_source"],
            "monitor_source": st["monitor_source"],
            "start_time": st["start_wall"],
            "end_time": time.time(),
            "duration_sec": round(duration, 2),
            "agent_offset_sec": st["agent_offset_sec"],
            "customer_offset_sec": st["customer_offset_sec"],
        }
        meta_path = st["dir"] / "meta.json"
        meta_path.write_text(json.dumps(meta, indent=2))
        return CallFiles(st["call_id"], st["dir"] / "agent.wav",
                         st["dir"] / "customer.wav", meta_path, duration)


def uuid4hex() -> str:
    return uuid.uuid4().hex


VAD_FRAME_SAMPLES = 480  # one 30 ms VAD frame at 16 kHz


def _trim_wav_tail(path: Path, drop_samples: int) -> None:
    """Rewrite a WAV without its last `drop_samples` samples."""
    with wave.open(str(path), "rb") as w:
        params = w.getparams()
        keep = max(0, w.getnframes() - drop_samples)
        w.rewind()
        frames = w.readframes(keep)
    with wave.open(str(path), "wb") as w:
        w.setparams(params)
        w.writeframes(frames)


def _wav_duration(path: Path, rate: int) -> float:
    with wave.open(str(path), "rb") as w:
        return round(w.getnframes() / rate, 2)
