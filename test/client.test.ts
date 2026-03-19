import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { WebSocketServer } from "ws";

import { TbrowserApiError, TbrowserClient, createTbrowserServer } from "../src/index.js";

let server: http.Server;
let wsServer: WebSocketServer;
let baseUrl: string;
let lastBody = "";

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }
    lastBody = Buffer.concat(chunks).toString("utf8");

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/policy") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        blocked_hosts: [],
        approval_hosts: [],
        approval_actions: ["desktop"],
        sensitive_eval_keywords: ["document.cookie"]
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/sessions/demo/uploads") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        artifact: {
          id: "artifact-1",
          session_id: "demo",
          kind: "upload",
          name: "hello.txt",
          path: "/tmp/hello.txt",
          content_type: "text/plain",
          size_bytes: 5,
          created_at: "2026-03-19T00:00:00Z",
          metadata: {}
        }
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/sessions/demo/screenshot") {
      res.writeHead(200, {
        "content-type": "image/png",
        "content-disposition": 'attachment; filename="shot.png"'
      });
      res.end(Buffer.from("png-data"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/sessions/demo/artifacts/artifact-1") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": 'attachment; filename="hello.txt"'
      });
      res.end("hello");
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/sessions/demo/eval") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "approval required" }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind test server");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;

  wsServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/v1/sessions/demo/events/ws") {
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({
          id: 1,
          kind: "audit",
          session_id: "demo",
          created_at: "2026-03-19T00:00:00Z",
          payload: { event: "connected" }
        }));
      });
      return;
    }
    socket.destroy();
  });
});

after(async () => {
  await new Promise<void>((resolve) => wsServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("TbrowserClient", () => {
  it("checks health and policy", async () => {
    const client = new TbrowserClient({ baseUrl: `${baseUrl}/` });
    assert.equal(await client.health(), "ok");
    const policy = await client.getPolicy();
    assert.deepEqual(policy.approval_actions, ["desktop"]);
    assert.equal(client.baseUrl, baseUrl);
  });

  it("uploads from path with base64 content", async () => {
    const tempDir = await mkdtemp(join(os.tmpdir(), "tbrowser-npm-"));
    const filePath = join(tempDir, "hello.txt");
    await writeFile(filePath, "hello");
    const client = new TbrowserClient({ baseUrl });

    const response = await client.uploadFileFromPath("demo", {
      selector: "#upload",
      path: filePath
    });

    assert.equal(response.artifact.kind, "upload");
    const parsed = JSON.parse(lastBody) as Record<string, string>;
    assert.equal(parsed.file_name, "hello.txt");
    assert.equal(parsed.selector, "#upload");
    assert.equal(parsed.content_base64, Buffer.from("hello").toString("base64"));
  });

  it("downloads screenshot and artifact to disk", async () => {
    const tempDir = await mkdtemp(join(os.tmpdir(), "tbrowser-npm-"));
    const screenshotPath = join(tempDir, "shot.png");
    const artifactPath = join(tempDir, "hello.txt");
    const client = new TbrowserClient({ baseUrl });

    const screenshot = await client.screenshot("demo");
    assert.equal(screenshot.fileName, "shot.png");
    assert.equal(screenshot.data.toString(), "png-data");

    await client.saveScreenshot("demo", screenshotPath);
    await client.downloadArtifactToPath("demo", "artifact-1", artifactPath);

    assert.equal((await readFile(screenshotPath, "utf8")).toString(), "png-data");
    assert.equal((await readFile(artifactPath, "utf8")).toString(), "hello");
  });

  it("raises structured api errors", async () => {
    const client = new TbrowserClient({ baseUrl });
    await assert.rejects(
      () => client.evaluate("demo", { expression: "document.cookie" }),
      (error: unknown) => {
        assert.ok(error instanceof TbrowserApiError);
        assert.equal(error.status, 403);
        assert.equal(error.message, "approval required");
        return true;
      }
    );
  });

  it("streams websocket session events", async () => {
    const client = new TbrowserClient({ baseUrl });
    const stream = client.subscribeSessionEvents("demo");
    const event = await new Promise<unknown>((resolve, reject) => {
      stream.on("event", resolve);
      stream.on("error", reject);
    });
    stream.close();
    assert.deepEqual(event, {
      id: 1,
      kind: "audit",
      session_id: "demo",
      created_at: "2026-03-19T00:00:00Z",
      payload: { event: "connected" }
    });
  });
});

describe("CLI", () => {
  it("prints health output", async () => {
    const cliPath = join(process.cwd(), "dist", "src", "cli.js");
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, "--base-url", baseUrl, "health"], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("exit", (code) => {
        if (code !== 0) {
          reject(new Error(stderr));
          return;
        }
        resolve(stdout);
      });
    });

    assert.deepEqual(JSON.parse(output), { ok: "ok" });
  });

  it("prints api and live-view guidance for serve", async () => {
    const cliPath = join(process.cwd(), "dist", "src", "cli.js");
    const dataDir = await mkdtemp(join(os.tmpdir(), "tbrowser-npm-serve-"));
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [cliPath, "serve", "--bind-addr", "127.0.0.1:38112", "--public-host", "127.0.0.1", "--data-dir", dataDir],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"]
        }
      );
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.includes("\n}\n") || stdout.trimEnd().endsWith("}")) {
          settled = true;
          child.kill("SIGINT");
          resolve(stdout);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("exit", (code, signal) => {
        if (settled) {
          return;
        }
        reject(new Error(`serve exited early with code=${code} signal=${signal}: ${stderr}`));
      });
    });

    const parsed = JSON.parse(output) as Record<string, string>;
    assert.equal(parsed.bind_addr, "127.0.0.1:38112");
    assert.equal(parsed.api_url, "http://127.0.0.1:38112");
    assert.equal(parsed.health_url, "http://127.0.0.1:38112/healthz");
    assert.equal(parsed.sessions_url, "http://127.0.0.1:38112/v1/sessions");
    assert.equal(parsed.live_view_url, "per-session");
    assert.equal(typeof parsed.live_view_note, "string");
    assert.match(parsed.live_view_note!, /launch\.headless=false/);
  });
});

describe("Server", () => {
  it("starts the embedded control plane and serves health and policy", async () => {
    const dataDir = await mkdtemp(join(os.tmpdir(), "tbrowser-npm-server-"));
    const server = await createTbrowserServer({
      bindAddr: "127.0.0.1:38111",
      dataDir,
      databasePath: join(dataDir, "state", "tbrowser.db")
    });
    await server.listen();
    try {
      const health = await fetch("http://127.0.0.1:38111/healthz");
      assert.equal(await health.text(), "ok");
      const policy = await fetch("http://127.0.0.1:38111/v1/policy").then(async (response) => response.json());
      assert.ok(Array.isArray(policy.approval_actions));
    } finally {
      await server.close();
    }
  });
});
