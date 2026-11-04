#!/bin/sh
# Isolated audio: a private PulseAudio daemon inside the container. The
# bot creates its null sinks against this server, so the host's default
# mic/speakers are never touched (the host-run bot had to hijack them).
set -e
mkdir -p "$XDG_RUNTIME_DIR" /profile /debug
chmod 700 "$XDG_RUNTIME_DIR" || true

# Stale socket/pid files from the image layer make the first start fail;
# clean and retry (a manual second start always worked).
rm -rf "$XDG_RUNTIME_DIR/pulse" 2>/dev/null || true
ok=""
for i in 1 2 3 4 5; do
  if pulseaudio -D --exit-idle-time=-1 --disallow-exit --log-target=stderr 2>/tmp/pulse.log; then ok=1; break; fi
  rm -rf "$XDG_RUNTIME_DIR/pulse" 2>/dev/null || true
  sleep 1
done
[ -n "$ok" ] || { echo "pulseaudio failed to start:"; cat /tmp/pulse.log; exit 1; }
for i in $(seq 1 20); do pactl info >/dev/null 2>&1 && break; sleep 0.5; done
pactl info >/dev/null

MODE="${1:-start}"
case "$MODE" in
  login)
    # Needs the host display (compose forwards DISPLAY + /tmp/.X11-unix):
    # a real Chrome window opens for the one-time Google sign-in. The
    # profile lives in the mounted /profile volume and survives rebuilds.
    exec npx tsx src/index.ts login
    ;;
  join|test-say|start|"")
    # Headed Chrome on a virtual display (Xvfb directly — xvfb-run needs
    # xauth, absent from this image's repos): Google rejects headless
    # Meet joins, but the bot must not open windows on the host desktop.
    Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
    export DISPLAY=:99
    sleep 1
    if [ "$MODE" = "start" ] || [ -z "$MODE" ]; then
      exec npx tsx src/index.ts
    fi
    exec npx tsx src/index.ts "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
