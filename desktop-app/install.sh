#!/bin/bash
# Arocall agent installer (Linux). Usage:
#   ./install.sh [--autostart] [--no-autostart] [--dir PATH]
# Installs into a venv under ~/.local/share/arocall and links ~/.local/bin/arocall-agent.
set -u
AUTOSTART="ask"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --autostart) AUTOSTART="on"; shift ;;
    --no-autostart) AUTOSTART="off"; shift ;;
    --dir) APP_DIR="$2"; shift 2 ;;
    --help|-h) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)"; exit 1 ;;
  esac
done

fail=0
need() { command -v "$1" >/dev/null 2>&1 || { echo "MISSING: $1 ($2)"; fail=1; }; }
need python3 "needs Python 3.10+"
need ffmpeg "sudo apt install ffmpeg (required: Opus encoding)"
need pactl "PulseAudio/PipeWire utilities, e.g. sudo apt install pulseaudio-utils"
need parec "same package as pactl"

pyver=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
if ! python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  echo "MISSING: python3 is $pyver, need 3.10+"; fail=1
fi
python3 -c 'import tkinter' 2>/dev/null || echo "WARN: python3-tk missing — settings window unavailable, terminal setup still works (Debian/Ubuntu: sudo apt install python3-tk)"
python3 -c 'import gi; gi.require_version("AppIndicator3", "0.1")' 2>/dev/null || echo "WARN: AppIndicator missing (common on GNOME) — tray falls back to terminal commands automatically."

[ $fail -ne 0 ] && { echo "Fix the MISSING items above and re-run."; exit 1; }

VENV="$HOME/.local/share/arocall/venv"
BIN="$HOME/.local/bin"
python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install "$APP_DIR"
mkdir -p "$BIN"
ln -sf "$VENV/bin/arocall-agent" "$BIN/arocall-agent"
echo "Installed: $BIN/arocall-agent (ensure ~/.local/bin is on your PATH)"

if [ "$AUTOSTART" = "ask" ]; then
  read -r -p "Start on login? [Y/n] " ans
  [ -z "$ans" ] || [ "$ans" = "Y" ] || [ "$ans" = "y" ] && AUTOSTART="on" || AUTOSTART="off"
fi
if [ "$AUTOSTART" = "on" ]; then
  "$BIN/arocall-agent" autostart on
fi
echo "Next: run \`arocall-agent setup\` and paste the session key from the dashboard (Employees > profile > Agent tab)."
