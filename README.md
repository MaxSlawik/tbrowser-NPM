# tbrowser-NPM

Node.js and npm client for [`tbrowser`](https://github.com/MaxSlawik/tbrowser), the local browser control plane for isolated Chromium sessions.

This package gives Node applications and scripts first-class access to the full `tbrowser` API:

- session lifecycle
- navigation, eval, snapshots, screenshots
- desktop input actions
- approvals and policy
- uploads, downloads, artifacts
- tabs, traces, network capture
- audit history and WebSocket session events
- profile import and export

## Install

```bash
npm install tbrowser-npm
```

## Requirements

- Node.js 18 or newer
- a running `tbrowser` API instance

Default API base URL:

```text
http://127.0.0.1:3000
```

## Library usage

```ts
import { TbrowserClient } from "tbrowser-npm";

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

const screenshotPath = await client.saveScreenshot(
  session.id,
  "./artifacts/example.png",
  { format: "png" }
);

console.log({ screenshotPath });
```

## File upload helpers

```ts
import { TbrowserClient } from "tbrowser-npm";

const client = new TbrowserClient();

await client.uploadFileFromPath("session-id", {
  selector: "#file-input",
  path: "./fixtures/invoice.pdf"
});

await client.uploadText("session-id", {
  selector: "#file-input",
  fileName: "note.txt",
  text: "uploaded from Node"
});
```

## Download helpers

```ts
const result = await client.waitForDownloadToPath(
  "session-id",
  "./downloads",
  { timeout_ms: 20_000 }
);

console.log(result.destinationPath);
```

## WebSocket session events

```ts
const stream = client.subscribeSessionEvents("session-id");
await stream.waitUntilOpen();

stream.on("event", (event) => {
  console.log(event.kind, event.payload);
});
```

## CLI usage

After install, the package exposes a `tbrowser` binary:

```bash
tbrowser health
tbrowser sessions create --json '{"label":"demo","launch":{"headless":true}}'
tbrowser sessions navigate SESSION_ID --url https://example.com
tbrowser sessions screenshot SESSION_ID --output ./page.png
tbrowser uploads from-path SESSION_ID --selector '#upload' --path ./document.pdf
tbrowser events stream SESSION_ID
```

CLI base URL selection:

```bash
tbrowser --base-url http://127.0.0.1:3000 health
TBROWSER_BASE_URL=http://127.0.0.1:3000 tbrowser policy
```

## API coverage

`TbrowserClient` includes methods for the full current server surface:

- `health`
- `getPolicy`
- `listProfiles`, `getProfile`, `importProfile`, `exportProfile`
- `listSessions`, `createSession`, `getSession`, `closeSession`, `getLiveView`
- `navigate`, `evaluate`, `snapshot`, `screenshot`, `saveScreenshot`
- `listEvents`, `subscribeSessionEvents`
- `listApprovals`, `createApproval`, `decideApproval`
- `listArtifacts`, `downloadArtifact`, `downloadArtifactToPath`
- `listTabs`, `createTab`, `activateTab`, `closeTab`
- `uploadFile`, `uploadFileFromPath`, `uploadText`
- `waitForDownload`, `waitForDownloadToPath`
- `captureNetwork`, `captureTrace`
- `moveMouse`, `clickMouse`, `dragMouse`, `typeText`, `pressKey`, `dragElement`
- `requestJson`, `requestBinary`

## Development

```bash
npm install
npm test
```

## Publish

The repository is structured for `npm publish`:

```bash
npm publish
```

If you want a scoped package name instead of `tbrowser-npm`, change the `name` field in `package.json` before publishing.
