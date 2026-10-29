"""Main loop: capture -> detect -> record 2 tracks -> Opus -> queue -> upload.
Plus heartbeat. Pause/quit via callbacks. Never holds a call in memory."""
import json
import logging
import time

from . import APP_NAME, VERSION

log = logging.getLogger("arocall.runner")

FRAME_BYTES = 3200 * 2  # 200ms @16kHz s16le mono... 16000*0.2*2 = 6400


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
        from .detect import CallDetector
        from .record import CallRecorder
        from .encode import to_opus
        from .queue import Queue
        from . import api as backend
        from .heartbeat import Heartbeat
        from . import config as app_config

        mod = audio_shim.load()
        data = app_config.data_dir()
        url = self.cfg["backend_url"]

        det = CallDetector(
            threshold=self.cfg["energy_threshold"], hangover_sec=self.cfg["hangover_sec"],
            preroll_sec=self.cfg["preroll_sec"], silence_timeout_sec=self.cfg["silence_timeout_sec"],
            min_call_sec=self.cfg["min_call_sec"],
            require_mic_activity=self.cfg["require_mic_activity"], frame_sec=0.2)
        rec = CallRecorder(data / "calls")
        deaths = []

        def on_death(source):
            deaths.append(source)
            log.error("capture subprocess died (%s); restarted", source)

        ms = mod.Stream(self.cfg["mic_source"], on_death=on_death)
        ns = mod.Stream(self.cfg["monitor_source"], on_death=on_death)

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
        log.info("runner started (mic=%s monitor=%s)", self.cfg["mic_source"], self.cfg["monitor_source"])

        try:
            while not self._stop:
                if app_config.load().get("paused"):
                    self.tray_set("idle", "paused")
                    time.sleep(1)
                    continue
                sys_pcm = ns.read(FRAME_BYTES)
                mic_pcm = ms.read(FRAME_BYTES)
                ev, pay = det.feed(mod.rms_level(sys_pcm), mod.rms_level(mic_pcm), sys_pcm, mic_pcm)
                if ev == "started":
                    rec.start(self.cfg["mic_source"], self.cfg["monitor_source"], pay["preroll"])
                    self.tray_set("recording", "")
                    self.notify("Arocall", "Call recording started")
                elif ev == "frame":
                    rec.write_frame(sys_pcm, mic_pcm)
                elif ev == "ended":
                    rec.write_frame(sys_pcm, mic_pcm)
                    files = rec.finish()
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
                elif ev == "discarded":
                    rec.abort()
        finally:
            hb.stop()
            queue.stop()
            ms.stop()
            ns.stop()

    def _status(self):
        from . import config as app_config
        return "paused" if app_config.load().get("paused") else "idle"
