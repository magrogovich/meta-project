"""60s heartbeat: status + version + queue size -> dashboard online/offline."""
import logging
import threading
import time

log = logging.getLogger("arocall.heartbeat")


class Heartbeat:
    def __init__(self, backend_url: str, get_key, state_fn, interval: int = 60):
        self.url = backend_url.rstrip("/")
        self.get_key = get_key      # () -> session key
        self.state_fn = state_fn    # () -> {status, version, queueSize}
        self.interval = interval
        self._stop = threading.Event()

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self):
        self._stop.set()

    def beat_once(self) -> bool:
        import requests

        key = self.get_key()
        if not key:
            return False
        st = self.state_fn()
        try:
            r = requests.post(self.url + "/api/agent/heartbeat", json={
                "sessionKey": None, "status": st.get("status", "idle"),
                "version": st.get("version", ""), "queueSize": st.get("queueSize", 0),
            }, headers={"X-Session-Key": key}, timeout=15)
            if r.status_code == 403:
                log.error("heartbeat: key revoked — open Settings to update it")
                return False
            return r.ok
        except requests.RequestException as e:
            log.warning("heartbeat failed (backend unreachable?): %s", str(e)[:120])
            return False

    def _loop(self):
        while not self._stop.is_set():
            self.beat_once()
            self._stop.wait(self.interval)
