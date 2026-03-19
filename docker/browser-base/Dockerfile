FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ARG TBROWSER_UID=10001
ARG TBROWSER_GID=10001

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    fluxbox \
    fonts-dejavu-core \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    fonts-noto-core \
    fonts-noto-extra \
    novnc \
    python3 \
    python3-websockify \
    supervisor \
    x11vnc \
    xdotool \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${TBROWSER_GID}" tbrowser \
    && useradd --uid "${TBROWSER_UID}" --gid "${TBROWSER_GID}" --create-home --shell /bin/bash tbrowser \
    && mkdir -p /opt/novnc/utils/websockify /data/profile /data/artifacts \
    && chown -R tbrowser:tbrowser /data /home/tbrowser

COPY docker/browser-base/tbrowser.html /usr/share/novnc/tbrowser.html
COPY docker/session-init/launch-session.sh /usr/local/bin/launch-session.sh

RUN chmod +x /usr/local/bin/launch-session.sh

EXPOSE 5900 6080 9222

HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD curl -fsS http://127.0.0.1:9222/json/version || exit 1

USER tbrowser

ENTRYPOINT ["/usr/local/bin/launch-session.sh"]
