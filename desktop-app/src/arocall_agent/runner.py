"""Main loop: capture -> VAD -> record 2 tracks -> Opus -> queue -> upload.
Plus heartbeat. Pause/quit via callbacks. Never holds a call in memory."""
import json
import logging
import time

from . import APP_NAME, VERSION
from .vad import FRAME_BYTES  # 30 ms @16kHz s16le mono = 960 bytes

log = logging.getLogger("arocall.runner")


class Runner:
    def __init__(self, cfg: dict, get_key, tray_set=None, notify=None):
        self.cfg = cfg
        self.get_key = get_key
        self.tray_set = tray_set or (lambda *a: None)
        self.notify = notify or (lambda *a: None)
        self._stop = False

    def stop(self):
        self._stop = True

    def run(self):
        from . import audio as audio_shim
        from .vad import CallStateMachine
        from .record import CallRecorder
        from .encode import to_opus
        from .queue import Queue
        from . import api as backend
        from .heartbeat import Heartbeat
        from . import config as app_config

        try:
            import webrtcvad  # noqa: F401
        except ImportError:
            msg = ("webrtcvad is not installed — the agent needs it for call detection. "
                   "Install it with `pip install webrtcvad-wheels` (prebuilt wheels, "
                   "no compiler needed), then restart the agent.")
            print(f"ERROR: {msg}")
            log.error(msg)
            return

        mod = audio_shim.load()
        data = app_config.data_dir()
        url = self.cfg["backend_url"]

        # Per-app capture: route the target app through our null sink and
        # record that sink's monitor instead of whole-system sound.
        app_mode = self.cfg.get("capture_mode") == "app" and bool((self.cfg.get("target_app") or "").strip())
        monitor_source = self.cfg["monitor_source"]
        if app_mode:
            from .audio_linux import APP_SINK, app_monitor_source, route_app_audio
            sink = self.cfg.get("app_sink") or APP_SINK
            try:
                moved = route_app_audio(self.cfg["target_app"], sink)
                monitor_source = app_monitor_source(sink)
                log.info("app capture: routing '%s' through %s (%d stream(s) moved)",
                         self.cfg["target_app"], sink, moved)
            except RuntimeError as e:
                log.error("app capture setup failed (%s) — falling back to system sound", e)
                app_mode = False

        sm = CallStateMachine(
            aggressiveness=self.cfg["vad_aggressiveness"], buffer_s=self.cfg["buffer_s"],
            min_speech_ms=self.cfg["min_speech_ms"], end_silence_s=self.cfg["end_silence_s"],
            min_call_s=self.cfg["min_call_s"])

        rec = CallRecorder(data / "calls")
        deaths = []

        def on_death(source):
            deaths.append(source)
            log.error("capture subprocess died (%s); restarted", source)

        ms = mod.Stream(self.cfg["mic_source"], on_death=on_death)
        ns = mod.Stream(monitor_source, on_death=on_death)

        def uploader(path, meta):
            key = self.get_key()
            backend.upload_tracks(url, key, path / "agent.ogg", path / "customer.ogg", meta)
            app_config.save({"last_upload_at": time.time()})

        queue = Queue(data / "queue", uploader, max_mb=self.cfg["max_queue_mb"])
        queue.start()
        hb = Heartbeat(url, self.get_key,
                       lambda: {"status": self._status(), "version": VERSION,
                                "queueSize": len(queue.pending())},
                       interval=self.cfg["heartbeat_sec"])
        hb.start()
        self.tray_set("idle", "")
        log.info("runner started (mic=%s monitor=%s vad_aggressiveness=%s)",
                 self.cfg["mic_source"], monitor_source, self.cfg["vad_aggressiveness"])

        def finish_call(payload, reason: str):
            files = rec.finish(drop_trailing_frames=payload["drop_frames"])
            log.info("call ended: %s (kept %.1fs)", reason, payload["duration_s"])
            self.tray_set("uploading", "")
            self.notify("Arocall", "Call ended — encoding & uploading")
            try:
                a_ogg = files.agent_wav.with_suffix(".ogg")
                c_ogg = files.customer_wav.with_suffix(".ogg")
                to_opus(files.agent_wav, a_ogg)
                to_opus(files.customer_wav, c_ogg)
                meta = json.loads(files.meta_path.read_text())
                queue.enqueue(files.call_id, a_ogg, c_ogg, {
                    "call_id": files.call_id, "language": "en",
                    "start_time": meta["start_time"], "end_time": meta["end_time"],
                    "duration_sec": meta["duration_sec"], "agent_version": VERSION,
                    "mic_source": meta["mic_source"], "monitor_source": meta["monitor_source"]})
                files.agent_wav.unlink(missing_ok=True)
                files.customer_wav.unlink(missing_ok=True)
                files.meta_path.unlink(missing_ok=True)
                try:
                    files.agent_wav.parent.rmdir()
                except OSError:
                    pass
            except Exception as e:
                log.error("encode/queue failed: %s", str(e)[:200])
            self.tray_set("idle", "")
            sm.acknowledge()

        def drop_call(reason: str):
            rec.abort()
            log.info("call discarded: %s", reason)
            self.tray_set("idle", "")
            sm.acknowledge()

        def drain_deaths():
            """Capture watchdog fired: finalize any in-progress call, fresh IDLE."""
            if not deaths:
                return
            for source in deaths:
                log.error("capture subprocess died (%s); restarted", source)
            deaths.clear()
            if sm.state == "RECORDING":
                ev, payload = sm.flush()
                if ev == "ended":
                    finish_call(payload, "capture restarted mid-call, uploaded what was recorded")
                else:
                    drop_call("capture restarted mid-call, too short to keep")
            sm.reset()  # suspend/resume or server restart: clear the buffer

        try:
            last_route = 0.0
            while not self._stop:
                drain_deaths()
                if app_config.load().get("paused"):
                    if sm.reset():
                        rec.abort()
                        log.info("paused: dropped partial call, staying idle")
                        self.tray_set("idle", "paused")
                    else:
                        self.tray_set("idle", "paused")
                    time.sleep(1)
                    continue
                if app_mode and time.time() - last_route > 2.0:
                    # pick up streams the app (re)started since the last check
                    try:
                        from .audio_linux import route_app_audio as _route
                        _route(self.cfg["target_app"], self.cfg.get("app_sink") or "arocall_app")
                    except RuntimeError as e:
                        log.warning("app re-route failed: %s", e)
                    last_route = time.time()
                sys_pcm = ns.read(FRAME_BYTES)
                mic_pcm = ms.read(FRAME_BYTES)
                ev, pay = sm.feed(mic_pcm, sys_pcm)
                if ev == "started":
                    rec.start(self.cfg["mic_source"], monitor_source, pay["buffer"])
                    log.info("call started: both sides active")
                    self.tray_set("recording", "")
                    self.notify("Arocall", "Call recording started")
                elif ev == "frame":
                    rec.write_frame(pay["sys_pcm"], pay["mic_pcm"])
                elif ev == "ended":
                    finish_call(pay, f"{self.cfg['end_silence_s']} s silence on both sides")
                elif ev == "discarded":
                    drop_call(f"shorter than {self.cfg['min_call_s']} s after trimming")
        finally:
            try:
                # Stopping mid-call must not lose the recording: finalize
                # what we have and hand it to the upload queue first.
                if sm.state == "RECORDING":
                    ev, payload = sm.flush()
                    if ev == "ended":
                        finish_call(payload, "agent stopping, uploaded what was recorded")
                    elif ev == "discarded":
                        drop_call("agent stopping, too short to keep")
                elif sm.state == "FINISHING":
                    sm.acknowledge()
            finally:
                hb.stop()
                queue.stop()
                ms.stop()
                ns.stop()

    def _status(self):
        from . import config as app_config
        return "paused" if app_config.load().get("paused") else "idle"
