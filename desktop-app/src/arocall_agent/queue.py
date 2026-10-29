"""Offline-tolerant upload queue: one dir per call, exponential-backoff retries,
resume after restart, delete only on backend confirmation, max-size warning."""
import json
import logging
import threading
import time
from pathlib import Path

log = logging.getLogger("arocall.queue")

RETRIES = [2, 4, 8, 16, 32, 60, 120, 300]


class Queue:
    def __init__(self, queue_dir: Path, uploader, max_mb: int = 500):
        self.dir = Path(queue_dir)
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.uploader = uploader  # fn(item) -> None (raises on failure)
        self.max_bytes = max_mb * 1024 * 1024
        self._stop = threading.Event()
        self._thread = None

    def enqueue(self, call_id: str, agent_ogg: Path, customer_ogg: Path, meta: dict) -> Path:
        d = self.dir / call_id
        d.mkdir(mode=0o700, exist_ok=True)
        import shutil
        shutil.move(str(agent_ogg), d / "agent.ogg")
        shutil.move(str(customer_ogg), d / "customer.ogg")
        (d / "meta.json").write_text(json.dumps({**meta, "call_id": call_id, "attempts": 0}))
        log.info("queued call %s", call_id)
        self._check_size()
        return d

    def pending(self) -> list:
        items = []
        for meta_path in sorted(self.dir.glob("*/meta.json")):
            try:
                items.append((meta_path.parent, json.loads(meta_path.read_text())))
            except Exception as e:
                log.error("bad queue entry %s: %s", meta_path.parent.name, e)
        return items

    def size_bytes(self) -> int:
        return sum(f.stat().st_size for f in self.dir.rglob("*") if f.is_file())

    def _check_size(self):
        if self.size_bytes() > self.max_bytes:
            log.warning("queue exceeds %d MB — oldest calls kept, uploads continue", self.max_bytes // (1024 * 1024))

    def start(self):
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        backoff_idx = 0
        while not self._stop.is_set():
            items = self.pending()
            if not items:
                backoff_idx = 0
                time.sleep(5)
                continue
            path, meta = items[0]
            try:
                self.uploader(path, meta)
                import shutil
                shutil.rmtree(path, ignore_errors=True)
                log.info("uploaded call %s (backend confirmed)", meta.get("call_id"))
                backoff_idx = 0
            except Exception as e:
                wait = RETRIES[min(backoff_idx, len(RETRIES) - 1)]
                backoff_idx += 1
                meta["attempts"] = meta.get("attempts", 0) + 1
                try:
                    (path / "meta.json").write_text(json.dumps(meta))
                except Exception:
                    pass
                log.warning("upload failed (%s); retry in %ss", str(e)[:150], wait)
                self._stop.wait(wait)
