"""Backend client. Session key travels only in memory + HTTPS/header, never in logs."""
import json
import logging

import requests

log = logging.getLogger("arocall.api")

TIMEOUT = 15


def _redact_error(e: Exception) -> str:
    return str(e)[:200]


def validate_key(backend_url: str, key: str) -> dict:
    """Returns {id, name, orgId} or raises ApiError."""
    try:
        r = requests.post(
            backend_url.rstrip("/") + "/api/agent/validate",
            json={},
            headers={"X-Session-Key": key},
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        raise ApiError(f"backend unreachable: {_redact_error(e)}")
    if r.status_code == 401:
        raise ApiError("invalid session key — check it with your admin")
    if r.status_code == 403:
        try:
            msg = r.json().get("message", "")
        except Exception:
            msg = ""
        raise ApiError("key revoked. " + (msg or "Ask your admin for a new key."), revoked=True)
    if not r.ok:
        raise ApiError(f"backend error HTTP {r.status_code}")
    return r.json()["employee"]


class ApiError(Exception):
    def __init__(self, message: str, revoked: bool = False):
        super().__init__(message)
        self.revoked = revoked


def upload_tracks(backend_url: str, key: str, agent_path, customer_path, meta: dict) -> dict:
    """POST /api/agent/calls (two tracks + metadata). Returns {done, duplicate, callId}."""
    try:
        with open(agent_path, "rb") as a, open(customer_path, "rb") as c:
            r = requests.post(
                backend_url.rstrip("/") + "/api/agent/calls",
                headers={"X-Session-Key": key},
                files={"agent_track": ("agent.ogg", a, "audio/ogg"),
                       "customer_track": ("customer.ogg", c, "audio/ogg")},
                data={"metadata": json.dumps(meta)},
                timeout=120,
            )
    except requests.RequestException as e:
        raise ApiError(f"upload failed: {_redact_error(e)}")
    if r.status_code == 401:
        raise ApiError("invalid session key — check it with your admin")
    if r.status_code == 403:
        raise ApiError("key revoked. Open Settings to update it. Recordings stay queued.", revoked=True)
    if not r.ok:
        raise ApiError(f"backend error HTTP {r.status_code}: {r.text[:150]}")
    return r.json()
