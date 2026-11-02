"""Settings window (tkinter). Tabs: session key, audio devices + meters + test.
Requires python3-tk; without it the terminal `setup` command applies instead."""

try:
    import tkinter as tk
    from tkinter import ttk, messagebox
    _TK = True
except ImportError:
    _TK = False

from . import config as app_config
from . import keystore
from . import api as backend
from . import audio as audio_shim


def available() -> bool:
    return _TK


def get_audio_choices() -> dict:
    mod = audio_shim.load()
    return mod.list_sources()


def test_streams(mic: str, monitor: str, seconds: int = 5) -> dict:
    """Record both streams briefly; return peak/avg RMS per stream."""
    import time

    mod = audio_shim.load()
    ms, ns = mod.Stream(mic), mod.Stream(monitor)
    try:
        frames = int(mod.RATE * seconds)
        chunk = mod.RATE // 5  # 200ms
        got = {"mic": [], "monitor": []}
        # interleave reads so both cover the same window
        steps = frames // chunk
        for _ in range(steps):
            got["mic"].append(mod.rms_level(ms.read(chunk * 2)))
            got["monitor"].append(mod.rms_level(ns.read(chunk * 2)))
        time.sleep(0)  # let watchdog settle
        out = {}
        for k, vals in got.items():
            out[k] = {"peak": max(vals) if vals else 0.0,
                      "avg": sum(vals) / len(vals) if vals else 0.0}
        return out
    finally:
        ms.stop()
        ns.stop()


class Meter:
    """Horizontal level bar 0..1."""

    def __init__(self, parent, width=220):
        self.canvas = tk.Canvas(parent, width=width, height=16, bg="#e5e7eb",
                                highlightthickness=0)
        self.width = width
        self.rect = self.canvas.create_rectangle(0, 0, 0, 16, fill="#16a34a", outline="")
        self.canvas.pack()

    def set(self, v: float):
        v = max(0.0, min(1.0, v))
        color = "#16a34a" if v < 0.5 else ("#f59e0b" if v < 0.8 else "#dc2626")
        self.canvas.coords(self.rect, 0, 0, self.width * v, 16)
        self.canvas.itemconfig(self.rect, fill=color)


def _level_db(rms: float) -> str:
    import math
    if rms <= 0:
        return "-inf dB"
    return f"{20 * math.log10(rms):.0f} dB"


def open_settings(on_key_saved=None):
    """Blocking settings window. on_key_saved() called after a successful connect."""
    if not _TK:
        print("tkinter is not installed — use `arocall-agent setup` in the terminal,")
        print("or install it (Debian/Ubuntu: `sudo apt install python3-tk`).")
        return
    cfg = app_config.load()
    mod = audio_shim.load()
    try:
        choices = get_audio_choices()
    except RuntimeError as e:
        messagebox.showerror("Audio tools missing", str(e))
        return

    root = tk.Tk()
    root.title("Arocall agent settings")
    root.geometry("480x560")
    try:
        from .icons import icon_path as _brand_icon
        _p = _brand_icon()
        if _p.is_file():
            _img = tk.PhotoImage(file=str(_p))
            root.iconphoto(True, _img)
            root._brand_icon_ref = _img  # keep a reference: Tk drops unreferenced images
    except Exception:
        pass
    nb = ttk.Notebook(root)
    nb.pack(fill="both", expand=True, padx=8, pady=8)

    # ---- key tab ----
    key_tab = ttk.Frame(nb)
    nb.add(key_tab, text="Session key")
    consent_var = tk.BooleanVar(value=bool(cfg.get("consent_accepted_at")))
    consent_box = ttk.Checkbutton(
        key_tab, variable=consent_var,
        text="I accept that calls handled on this computer are recorded and analyzed by my employer.")
    consent_box.pack(padx=12, pady=(12, 0), anchor="w")
    if cfg.get("notice_text"):
        ttk.Label(key_tab, text=f"Company notice: {cfg['notice_text']}", wraplength=420).pack(padx=12, anchor="w")
    ttk.Label(key_tab, text="Paste the key from the dashboard (Employees > profile > Agent tab).").pack(pady=(12, 4))
    key_var = tk.StringVar()
    row = ttk.Frame(key_tab)
    row.pack(fill="x", padx=12)
    entry = ttk.Entry(row, textvariable=key_var, show="•", width=48)
    entry.pack(side="left", fill="x", expand=True)
    eye = ttk.Button(row, text="👁", width=3,
                     command=lambda: entry.config(show="" if entry.cget("show") else "•"))
    eye.pack(side="left", padx=(4, 0))
    status_var = tk.StringVar(value="")
    ttk.Label(key_tab, textvariable=status_var, wraplength=420).pack(pady=8)

    def save_connect():
        if not consent_var.get():
            status_var.set("Please accept call recording first (checkbox above).")
            return
        key = key_var.get().strip()
        if not key:
            status_var.set("Paste a key first.")
            return
        status_var.set("Checking…")
        root.update_idletasks()
        try:
            emp = backend.validate_key(cfg["backend_url"], key)
        except backend.ApiError as e:
            status_var.set(f"Error: {e}")
            return
        where = keystore.save_key(key)
        from datetime import datetime, timezone
        patch = {"employee_name": emp["name"]}
        if not cfg.get("consent_accepted_at"):
            patch["consent_accepted_at"] = datetime.now(timezone.utc).isoformat()
        app_config.save(patch)
        status_var.set(f"Connected as {emp['name']} (stored via {where}). Recorder restarts.")
        if on_key_saved:
            on_key_saved()

    ttk.Button(key_tab, text="Save and connect", command=save_connect).pack(pady=4)

    # ---- audio tab ----
    au_tab = ttk.Frame(nb)
    nb.add(au_tab, text="Audio")

    def current_apps():
        try:
            return mod.list_apps()
        except Exception:
            return []

    def app_match_of(a: dict) -> str:
        return (a.get("binary") or a.get("app") or "").strip()

    def app_label_of(a: dict) -> str:
        name = a.get("app") or a.get("binary") or "unknown app"
        media = a.get("media") or ""
        return f"{name} — {media}" if media else name

    mode_var = tk.StringVar(value=cfg.get("capture_mode") or "system")
    target_var = tk.StringVar(value=cfg.get("target_app") or "")
    apps_cache: dict = {}

    ttk.Label(au_tab, text="Capture:").pack(anchor="w", padx=12, pady=(12, 0))
    mode_row = ttk.Frame(au_tab)
    mode_row.pack(fill="x", padx=12)
    ttk.Radiobutton(mode_row, text="Entire system sound", variable=mode_var, value="system").pack(side="left")
    ttk.Radiobutton(mode_row, text="One specific app", variable=mode_var, value="app").pack(side="left", padx=(12, 0))

    app_row = ttk.Frame(au_tab)
    app_row.pack(fill="x", padx=12, pady=(6, 0))
    ttk.Label(app_row, text="App:").pack(side="left")
    app_box = ttk.Combobox(app_row, textvariable=target_var, width=40)
    app_box.pack(side="left", fill="x", expand=True, padx=(6, 4))
    ttk.Button(app_row, text="Refresh",
               command=lambda: refresh_apps()).pack(side="left")
    ttk.Label(au_tab, text="Pick a running app above (or type its name — e.g. the softphone or browser you take calls in). Only that app's sound is recorded.",
              wraplength=430).pack(padx=12, anchor="w")

    def refresh_apps():
        apps = current_apps()
        apps_cache.clear()
        vals = []
        for a in apps:
            m = app_match_of(a)
            if not m:
                continue
            apps_cache[app_label_of(a)] = m
            vals.append(app_label_of(a))
        app_box.config(values=vals)
        if not vals:
            test_var.set("No apps are playing sound right now — play audio or start a call in the app, "
                         "then press Refresh. You can also type the app name manually (while it plays "
                         "sound, run: pactl list sink-inputs | grep application.name).")

    def effective_monitor() -> str:
        if mode_var.get() == "app" and target_var.get().strip():
            try:
                from .audio_linux import APP_SINK, app_monitor_source
                return app_monitor_source(cfg.get("app_sink") or APP_SINK)
            except Exception:
                pass
        return mon_var.get()

    def save_audio_mode(*_a):
        app_config.save({"capture_mode": mode_var.get(), "target_app": target_var.get().strip()})
        mon_box.config(state="disabled" if mode_var.get() == "app" else "readonly")
        restart_live()

    mic_var = tk.StringVar(value=cfg.get("mic_source") or choices["default_input"])
    mon_var = tk.StringVar(value=cfg.get("monitor_source") or choices["default_monitor"])
    ttk.Label(au_tab, text="Microphone (Agent track):").pack(anchor="w", padx=12, pady=(12, 0))
    mic_box = ttk.Combobox(au_tab, textvariable=mic_var, state="readonly", width=60,
                           values=[s["name"] for s in choices["inputs"]] or [choices["default_input"]])
    mic_box.pack(padx=12, fill="x")
    mic_meter = Meter(au_tab)
    ttk.Label(au_tab, text="System sound (Customer track) — records all sound played by this computer:").pack(anchor="w", padx=12, pady=(8, 0))
    mon_box = ttk.Combobox(au_tab, textvariable=mon_var, state="readonly", width=60,
                           values=[s["name"] for s in choices["monitors"]])
    mon_box.pack(padx=12, fill="x")
    mon_meter = Meter(au_tab)
    ttk.Label(au_tab, text="Tip: use headphones, otherwise the customer's voice leaks into the microphone track.",
              wraplength=430).pack(padx=12, pady=6)
    test_var = tk.StringVar(value="")
    ttk.Label(au_tab, textvariable=test_var, wraplength=430).pack(padx=12)

    live = {"ms": None, "ns": None, "run": True}

    def ensure_live():
        try:
            if live["ms"] is None:
                live["ms"] = mod.Stream(mic_var.get())
                live["ns"] = mod.Stream(effective_monitor())
        except RuntimeError as e:
            test_var.set(f"Audio error: {e}")
            return False
        return True

    def poll_meters():
        if not live["run"]:
            return
        try:
            if ensure_live():
                mic_meter.set(mod.rms_level(live["ms"].read(mod.RATE // 5 * 2)) * 4)
                mon_meter.set(mod.rms_level(live["ns"].read(mod.RATE // 5 * 2)) * 4)
        except Exception:
            live["ms"] = live["ns"] = None
        root.after(200, poll_meters)

    def restart_live(*_a):
        for k in ("ms", "ns"):
            try:
                if live[k]:
                    live[k].stop()
            except Exception:
                pass
            live[k] = None
        app_config.save({"mic_source": mic_var.get(), "monitor_source": mon_var.get()})

    mic_box.bind("<<ComboboxSelected>>", restart_live)
    mon_box.bind("<<ComboboxSelected>>", restart_live)

    def on_app_picked(*_a):
        label = target_var.get().strip()
        if label in apps_cache:
            target_var.set(apps_cache[label])
        save_audio_mode()

    app_box.bind("<<ComboboxSelected>>", on_app_picked)
    app_box.bind("<FocusOut>", on_app_picked)
    mode_var.trace_add("write", save_audio_mode)
    mon_box.config(state="disabled" if mode_var.get() == "app" else "readonly")
    refresh_apps()

    def do_test():
        test_var.set("Recording 5 seconds — make some noise…")
        root.update_idletasks()
        try:
            res = test_streams(mic_var.get(), effective_monitor(), 5)
            test_var.set(
                f"Mic peak {_level_db(res['mic']['peak'])} / avg {_level_db(res['mic']['avg'])}; "
                f"system peak {_level_db(res['monitor']['peak'])} / avg {_level_db(res['monitor']['avg'])}. "
                "If both stay at -inf dB while sound plays, pick another source above.")
        except RuntimeError as e:
            test_var.set(f"Audio error: {e}")

    import threading
    ttk.Button(au_tab, text="Test: record 5 seconds",
               command=lambda: threading.Thread(target=do_test, daemon=True).start()).pack(pady=6)
    poll_meters()

    def on_close():
        live["run"] = False
        for k in ("ms", "ns"):
            try:
                if live[k]:
                    live[k].stop()
            except Exception:
                pass
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)

    # ---- info tab ----
    info_tab = ttk.Frame(nb)
    nb.add(info_tab, text="Info")
    info_var = tk.StringVar(value="")
    ttk.Label(info_tab, textvariable=info_var, justify="left", wraplength=430).pack(padx=12, pady=12, anchor="w")

    def refresh_info():
        from . import diagnostics as diag_mod
        from . import VERSION as AGENT_VERSION
        qdir = app_config.data_dir() / "queue"
        pending = len(list(qdir.glob("*/meta.json"))) if qdir.exists() else 0
        c = app_config.load()
        last = c.get("last_upload_at")
        import datetime
        last_s = datetime.datetime.fromtimestamp(last).strftime("%Y-%m-%d %H:%M") if last else "never"
        info_var.set(
            f"Agent version: {AGENT_VERSION}\nBackend: {c.get('backend_url')}\n"
            f"Queue: {pending} call(s) waiting\nLast upload: {last_s}")

    def open_logs():
        import subprocess
        d = app_config.data_dir() / "logs"
        try:
            subprocess.run(["xdg-open", str(d)], check=False)
        except Exception:
            info_var.set(f"Logs folder: {d}")

    def copy_diag():
        from . import diagnostics as diag_mod
        text = diag_mod.format_text(diag_mod.collect())
        root.clipboard_clear()
        root.clipboard_append(text)
        info_var.set(info_var.get() + "\n\nDiagnostics copied to clipboard.")

    btns = ttk.Frame(info_tab)
    btns.pack(padx=12, anchor="w")
    ttk.Button(btns, text="Refresh", command=refresh_info).pack(side="left")
    ttk.Button(btns, text="Open logs folder", command=open_logs).pack(side="left", padx=4)
    ttk.Button(btns, text="Copy diagnostics", command=copy_diag).pack(side="left")
    refresh_info()

    # ---- advanced tab (read-only VAD tuning values) ----
    adv_tab = ttk.Frame(nb)
    nb.add(adv_tab, text="Advanced")
    ttk.Label(adv_tab, text="Call-detection tuning (voice activity detection).",
              wraplength=430).pack(padx=12, pady=(12, 4), anchor="w")
    adv_cfg = app_config.load()
    for key, hint in [
        ("vad_aggressiveness", "0-3; higher = stricter about what counts as speech"),
        ("buffer_s", "rolling pre-roll window kept in memory while idle (s)"),
        ("min_speech_ms", "speech per stream in the window required to start (ms)"),
        ("end_silence_s", "both-silence seconds before a call ends (s)"),
        ("min_call_s", "shorter calls are discarded after trimming (s)"),
    ]:
        ttk.Label(adv_tab, text=f"{key} = {adv_cfg.get(key)}  ({hint})",
                  wraplength=430).pack(padx=12, anchor="w")
    ttk.Label(adv_tab, text="Edit these in ~/.config/arocall/config.json while the agent is stopped. "
              "Watch them live with: arocall-agent monitor (records nothing).",
              wraplength=430).pack(padx=12, pady=(8, 0), anchor="w")
    root.mainloop()
