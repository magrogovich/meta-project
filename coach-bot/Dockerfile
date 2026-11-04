# Coach bot — isolated runtime: its own PulseAudio server, Xvfb display and
# Chrome profile, so a session never touches the host's audio devices.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth pulseaudio pulseaudio-utils alsa-utils dbus-x11 \
      wget gnupg ca-certificates fonts-liberation procps \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb \
    && rm /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# Non-root: PulseAudio refuses to run as root, and Chrome is happier too.
# The image's `node` user is uid 1000, matching the typical host user so
# the mounted profile volume (host-owned) stays readable/writable.
RUN mkdir -p /profile /debug /tmp/runtime && chown -R node:node /profile /debug /tmp/runtime /app
USER node

ENV HOME=/home/node \
    XDG_RUNTIME_DIR=/tmp/runtime \
    COACH_BOT_CHANNEL=chrome \
    COACH_BOT_HEADLESS=false \
    COACH_BOT_PROFILE_DIR=/profile \
    COACH_BOT_DEBUG_DIR=/debug

ENTRYPOINT ["./entrypoint.sh"]
CMD ["start"]
