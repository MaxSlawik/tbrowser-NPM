#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export VIEWPORT_WIDTH="${VIEWPORT_WIDTH:-1440}"
export VIEWPORT_HEIGHT="${VIEWPORT_HEIGHT:-960}"
export INITIAL_URL="${INITIAL_URL:-about:blank}"
export BROWSER_LOCALE="${BROWSER_LOCALE:-en-US}"
export HEADLESS="${HEADLESS:-false}"
export PROXY_AUTH_FILE="${PROXY_AUTH_FILE:-}"
export LIVE_VIEW_PASSWORD_FILE="${LIVE_VIEW_PASSWORD_FILE:-}"

mkdir -p /data/profile /data/artifacts

cleanup() {
  kill "${CHROME_PID:-}" "${CDP_PROXY_PID:-}" "${NOVNC_PID:-}" "${X11VNC_PID:-}" "${FLUXBOX_PID:-}" "${XVFB_PID:-}" 2>/dev/null || true
  rm -rf "${PROXY_EXTENSION_DIR:-}" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

prepare_proxy_extension() {
  if [[ -z "${PROXY_AUTH_FILE}" || ! -f "${PROXY_AUTH_FILE}" ]]; then
    return 0
  fi

  local extension_dir
  extension_dir="$(mktemp -d /tmp/tbrowser-proxy-auth.XXXXXX)"

  python3 - "${PROXY_AUTH_FILE}" "${extension_dir}" <<'PY'
import json
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
extension_dir = pathlib.Path(sys.argv[2])
credentials = json.loads(source.read_text())

manifest = {
    "manifest_version": 3,
    "name": "tbrowser-proxy-auth",
    "version": "1.0.0",
    "minimum_chrome_version": "109",
    "permissions": [
        "webRequest",
        "webRequestAuthProvider",
    ],
    "host_permissions": ["<all_urls>"],
    "background": {
        "service_worker": "background.js",
    },
}

background = f"""
const credentials = {json.dumps(credentials)};

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {{
    if (!details.isProxy) {{
      callback({{}});
      return;
    }}
    callback({{ authCredentials: credentials }});
  }},
  {{ urls: ["<all_urls>"] }},
  ["asyncBlocking"]
);
"""

(extension_dir / "manifest.json").write_text(json.dumps(manifest))
(extension_dir / "background.js").write_text(background.strip() + "\n")
source.unlink(missing_ok=True)
PY

  PROXY_EXTENSION_DIR="${extension_dir}"
}

if [[ "${HEADLESS}" != "true" ]]; then
  Xvfb "${DISPLAY}" -screen 0 "${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}x24" -ac +extension RANDR &
  XVFB_PID=$!

  fluxbox >/data/artifacts/fluxbox.log 2>&1 &
  FLUXBOX_PID=$!

  X11VNC_ARGS=(-display "${DISPLAY}" -forever -shared -rfbport 5900)
  if [[ -n "${LIVE_VIEW_PASSWORD_FILE}" && -f "${LIVE_VIEW_PASSWORD_FILE}" ]]; then
    X11VNC_ARGS+=(-passwdfile "${LIVE_VIEW_PASSWORD_FILE}")
  else
    X11VNC_ARGS+=(-nopw)
  fi
  x11vnc "${X11VNC_ARGS[@]}" >/data/artifacts/x11vnc.log 2>&1 &
  X11VNC_PID=$!

  websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/data/artifacts/novnc.log 2>&1 &
  NOVNC_PID=$!
fi

python3 - <<'PY' >/data/artifacts/cdp-proxy.log 2>&1 &
import socket
import threading

LISTEN = ("0.0.0.0", 9222)
TARGET = ("127.0.0.1", 9223)


def forward(source, destination):
    try:
        while True:
            chunk = source.recv(65536)
            if not chunk:
                break
            destination.sendall(chunk)
    finally:
        try:
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass


server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(LISTEN)
server.listen()

while True:
    client, _ = server.accept()
    try:
        upstream = socket.create_connection(TARGET, timeout=2)
    except OSError:
        client.close()
        continue
    threading.Thread(target=forward, args=(client, upstream), daemon=True).start()
    threading.Thread(target=forward, args=(upstream, client), daemon=True).start()
PY
CDP_PROXY_PID=$!

prepare_proxy_extension

CHROME_FLAGS=(
  --no-sandbox
  --no-first-run
  --no-default-browser-check
  --disable-dev-shm-usage
  --disable-background-networking
  --disable-blink-features=AutomationControlled
  --disable-component-update
  --disable-features=Translate,BackForwardCache,AcceptCHFrame
  --disable-renderer-backgrounding
  --disable-sync
  --enable-webgl
  --enable-logging=stderr
  --hide-scrollbars
  --ignore-gpu-blocklist
  --lang="${BROWSER_LOCALE}"
  --password-store=basic
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port=9223
  --use-angle=swiftshader
  --use-gl=angle
  --user-data-dir=/data/profile
  --window-size="${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}"
)

if [[ "${HEADLESS}" == "true" ]]; then
  CHROME_FLAGS+=(
    --headless=new
  )
fi

if [[ -n "${PROXY_URL:-}" ]]; then
  CHROME_FLAGS+=("--proxy-server=${PROXY_URL}")
fi

if [[ -n "${PROXY_BYPASS:-}" ]]; then
  CHROME_FLAGS+=("--proxy-bypass-list=${PROXY_BYPASS}")
fi

if [[ -n "${PROXY_EXTENSION_DIR:-}" ]]; then
  CHROME_FLAGS+=(
    "--disable-extensions-except=${PROXY_EXTENSION_DIR}"
    "--load-extension=${PROXY_EXTENSION_DIR}"
  )
fi

chromium "${CHROME_FLAGS[@]}" "${INITIAL_URL}" >/data/artifacts/chromium.log 2>&1 &
CHROME_PID=$!

wait "${CHROME_PID}"
