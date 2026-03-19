# tbrowser

Full Node.js and npm runtime for [`tbrowser`](https://github.com/MaxSlawik/tbrowser).

This repository now includes both:

- a typed Node client and CLI
- a full Node control plane that launches isolated Chromium sessions in Docker

The npm package can run the server itself with `tbrowser serve`. It does not depend on the Rust implementation at runtime.

## What it includes

- session lifecycle API
- navigation, eval, DOM snapshots, screenshots
- desktop mouse and keyboard control through `docker exec` + `xdotool`
- approvals and local policy enforcement
- uploads, download detection, artifacts
- tabs, network captures, traces
- audit history and WebSocket session events
- named profile import and export
- bundled browser image assets for local Docker builds

## Install

```bash
npm install @maximilianslawik/tbrowser
```

## Requirements

- Node.js 18 or newer
- Docker daemon reachable from the local host

## Build the browser image

The server expects a browser image tagged as `tbrowser/browser-base:local` unless you override `TBROWSER_BROWSER_IMAGE`.

From this repository:

```bash
npm run build:image
```

## Run the server

```bash
tbrowser serve
```

Or with explicit settings:

```bash
tbrowser serve \
  --bind-addr 127.0.0.1:3000 \
  --data-dir ./storage \
  --browser-image tbrowser/browser-base:local \
  --public-host 127.0.0.1
```

Default API base:

```text
http://127.0.0.1:3000
```

## Environment variables

- `TBROWSER_BIND_ADDR`
  Default: `127.0.0.1:3000`
- `TBROWSER_DATA_DIR`
  Default: `./storage`
- `TBROWSER_DATABASE_URL`
  Default: `sqlite:${TBROWSER_DATA_DIR}/state/tbrowser.db`
- `TBROWSER_BROWSER_IMAGE`
  Default: `tbrowser/browser-base:local`
- `TBROWSER_PUBLIC_HOST`
  Default: `127.0.0.1`
- `TBROWSER_CLEANUP_INTERVAL_SECONDS`
  Default: `30`
- `TBROWSER_IDLE_TIMEOUT_SECONDS`
  Default: `300`
- `TBROWSER_APPROVAL_TTL_SECONDS`
  Default: `600`
- `TBROWSER_POLICY_PATH`
  Optional JSON file for blocked hosts, approval hosts, approval-gated actions, and sensitive eval keywords

## Policy file shape

```json
{
  "blocked_hosts": ["*.internal.example"],
  "approval_hosts": ["accounts.google.com", "*.bank.example"],
  "approval_actions": ["desktop", "upload", "download", "tab_close"],
  "sensitive_eval_keywords": ["document.cookie", "navigator.clipboard"]
}
```

## Client usage

```ts
import { TbrowserClient } from "@maximilianslawik/tbrowser";

const client = new TbrowserClient({
  baseUrl: "http://127.0.0.1:3000"
});

const session = await client.createSession({
  label: "demo",
  initial_url: "https://example.com",
  launch: {
    headless: true
  }
});

const snapshot = await client.snapshot(session.id);
console.log(snapshot.title);
```

## Embedded server usage from code

```ts
import { createTbrowserServer } from "@maximilianslawik/tbrowser";

const server = await createTbrowserServer({
  bindAddr: "127.0.0.1:3000",
  dataDir: "./storage"
});

await server.listen();
```

## CLI examples

```bash
tbrowser health
tbrowser policy
tbrowser sessions create --json '{"label":"demo","launch":{"headless":true}}'
tbrowser sessions navigate SESSION_ID --url https://example.com
tbrowser sessions screenshot SESSION_ID --output ./page.png
tbrowser uploads from-path SESSION_ID --selector '#upload' --path ./document.pdf
tbrowser events stream SESSION_ID
```

## API coverage

The Node runtime exposes the same control-plane surface as the Rust repo:

- `POST /v1/sessions`
- `GET /v1/sessions`
- `GET /v1/sessions/{session_id}`
- `DELETE /v1/sessions/{session_id}`
- `GET /v1/sessions/{session_id}/live`
- `POST /v1/sessions/{session_id}/navigate`
- `POST /v1/sessions/{session_id}/eval`
- `POST /v1/sessions/{session_id}/snapshot`
- `POST /v1/sessions/{session_id}/screenshot`
- `GET /v1/sessions/{session_id}/events`
- `GET /v1/sessions/{session_id}/events/ws`
- `GET /v1/policy`
- `GET /v1/sessions/{session_id}/approvals`
- `POST /v1/sessions/{session_id}/approvals`
- `POST /v1/approvals/{approval_id}/decision`
- `GET /v1/sessions/{session_id}/artifacts`
- `GET /v1/sessions/{session_id}/artifacts/{artifact_id}`
- `GET /v1/sessions/{session_id}/tabs`
- `POST /v1/sessions/{session_id}/tabs`
- `POST /v1/sessions/{session_id}/tabs/{tab_id}/activate`
- `POST /v1/sessions/{session_id}/tabs/{tab_id}/close`
- `POST /v1/sessions/{session_id}/uploads`
- `POST /v1/sessions/{session_id}/downloads/wait`
- `POST /v1/sessions/{session_id}/captures/network`
- `POST /v1/sessions/{session_id}/captures/trace`
- `POST /v1/sessions/{session_id}/desktop/mouse/move`
- `POST /v1/sessions/{session_id}/desktop/mouse/click`
- `POST /v1/sessions/{session_id}/desktop/mouse/drag`
- `POST /v1/sessions/{session_id}/desktop/keyboard/type`
- `POST /v1/sessions/{session_id}/desktop/keyboard/key`
- `POST /v1/sessions/{session_id}/desktop/drag-element`
- `GET /v1/profiles`
- `GET /v1/profiles/{profile_id}`
- `POST /v1/profiles/import`
- `POST /v1/profiles/{profile_id}/export`

## Development

```bash
npm install
npm test
npm run build:image
```

## Publish

The package is structured for `npm publish`:

```bash
npm publish
```

If you want a scoped package name, change the `name` field in `package.json` before publishing.
