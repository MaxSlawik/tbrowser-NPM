import http from "node:http";
import { parse as parseUrl } from "node:url";

import express from "express";
import { WebSocketServer } from "ws";

import { ensureLayout, loadConfigFromEnv, type AppConfig } from "./runtime/config.js";
import { BrowserService, HttpError } from "./runtime/service.js";

export interface TbrowserServer {
  service: BrowserService;
  config: AppConfig;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export async function createTbrowserServer(overrides: Partial<AppConfig> = {}): Promise<TbrowserServer> {
  const config = await loadConfigFromEnv(overrides);
  await ensureLayout(config);

  const service = new BrowserService(config);
  const app = express();
  app.use(express.json({ limit: "100mb" }));

  app.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
  });

  app.get("/v1/policy", (_req, res) => {
    res.json(service.policySnapshot());
  });

  app.get("/v1/profiles", wrapJson(async (_req) => service.listProfiles()));
  app.post("/v1/profiles/import", wrapJson(async (req, res) => {
    res.status(201);
    return service.importProfile(req.body);
  }));
  app.get("/v1/profiles/:profileId", wrapJson(async (req) => service.getProfile(param(req.params.profileId))));
  app.post("/v1/profiles/:profileId/export", wrapJson(async (req) => service.exportProfile(param(req.params.profileId), req.body)));

  app.get("/v1/sessions", wrapJson(async () => service.listSessions()));
  app.post("/v1/sessions", wrapJson(async (req, res) => {
    res.status(201);
    return service.createSession(req.body);
  }));
  app.get("/v1/sessions/:sessionId", wrapJson(async (req) => service.getSession(param(req.params.sessionId))));
  app.delete("/v1/sessions/:sessionId", wrapJson(async (req) => service.closeSession(param(req.params.sessionId))));
  app.get("/v1/sessions/:sessionId/live", wrapJson(async (req) => service.liveView(param(req.params.sessionId))));
  app.post("/v1/sessions/:sessionId/navigate", wrapJson(async (req) => service.navigate(param(req.params.sessionId), req.body)));
  app.post("/v1/sessions/:sessionId/eval", wrapJson(async (req) => service.evaluate(param(req.params.sessionId), req.body)));
  app.post("/v1/sessions/:sessionId/snapshot", wrapJson(async (req) => service.snapshot(param(req.params.sessionId))));
  app.post("/v1/sessions/:sessionId/screenshot", async (req, res) => {
    try {
      const { bytes, artifact } = await service.screenshot(param(req.params.sessionId), req.body ?? {});
      res.setHeader("content-type", artifact.content_type);
      res.status(200).send(bytes);
    } catch (error) {
      sendError(res, error);
    }
  });
  app.get("/v1/sessions/:sessionId/events", wrapJson(async (req) => service.listAuditEvents(param(req.params.sessionId))));
  app.get("/v1/sessions/:sessionId/approvals", wrapJson(async (req) => service.listApprovals(param(req.params.sessionId))));
  app.post("/v1/sessions/:sessionId/approvals", wrapJson(async (req, res) => {
    res.status(201);
    return service.createApproval(param(req.params.sessionId), req.body);
  }));
  app.post("/v1/approvals/:approvalId/decision", wrapJson(async (req) => service.decideApproval(param(req.params.approvalId), req.body)));
  app.get("/v1/sessions/:sessionId/artifacts", wrapJson(async (req) => service.listArtifacts(param(req.params.sessionId))));
  app.get("/v1/sessions/:sessionId/artifacts/:artifactId", async (req, res) => {
    try {
      const artifact = await service.readArtifact(param(req.params.sessionId), param(req.params.artifactId));
      res.setHeader("content-type", artifact.contentType);
      res.status(200).send(artifact.bytes);
    } catch (error) {
      sendError(res, error);
    }
  });
  app.get("/v1/sessions/:sessionId/tabs", wrapJson(async (req) => service.listTabs(param(req.params.sessionId))));
  app.post("/v1/sessions/:sessionId/tabs", wrapJson(async (req, res) => {
    res.status(201);
    return service.createTab(param(req.params.sessionId), req.body ?? {});
  }));
  app.post("/v1/sessions/:sessionId/tabs/:tabId/activate", wrapJson(async (req, res) => {
    await service.activateTab(param(req.params.sessionId), param(req.params.tabId));
    res.status(204);
    return undefined;
  }));
  app.post("/v1/sessions/:sessionId/tabs/:tabId/close", wrapJson(async (req, res) => {
    await service.closeTab(param(req.params.sessionId), param(req.params.tabId), queryStringValue(req.query.approval_id));
    res.status(204);
    return undefined;
  }));
  app.post("/v1/sessions/:sessionId/uploads", wrapJson(async (req, res) => {
    res.status(201);
    return service.uploadFile(param(req.params.sessionId), req.body);
  }));
  app.post("/v1/sessions/:sessionId/downloads/wait", wrapJson(async (req) => service.waitForDownload(param(req.params.sessionId), req.body ?? {})));
  app.post("/v1/sessions/:sessionId/captures/network", wrapJson(async (req) => service.captureNetwork(param(req.params.sessionId), req.body ?? {})));
  app.post("/v1/sessions/:sessionId/captures/trace", wrapJson(async (req) => service.captureTrace(param(req.params.sessionId), req.body ?? {})));
  app.post("/v1/sessions/:sessionId/desktop/mouse/move", wrapJson(async (req) => service.moveMouse(param(req.params.sessionId), req.body)));
  app.post("/v1/sessions/:sessionId/desktop/mouse/click", wrapJson(async (req) => service.clickMouse(param(req.params.sessionId), req.body)));
  app.post("/v1/sessions/:sessionId/desktop/mouse/drag", wrapJson(async (req) => service.dragMouse(param(req.params.sessionId), req.body)));
  app.post("/v1/sessions/:sessionId/desktop/keyboard/type", wrapJson(async (req) => service.typeText(param(req.params.sessionId), req.body)));
  app.post("/v1/sessions/:sessionId/desktop/keyboard/key", wrapJson(async (req) => service.pressKey(param(req.params.sessionId), req.body)));
  app.post("/v1/sessions/:sessionId/desktop/drag-element", wrapJson(async (req) => service.dragElement(param(req.params.sessionId), req.body)));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const cleanupTimer = setInterval(() => {
    void service.cleanupOnce();
  }, Math.max(config.cleanupIntervalSeconds, 1) * 1000);

  server.on("upgrade", async (request, socket, head) => {
    const pathname = parseUrl(request.url ?? "").pathname ?? "";
    const match = /^\/v1\/sessions\/([^/]+)\/events\/ws$/.exec(pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const sessionId = decodeURIComponent(match[1] ?? "");
    try {
      service.getSession(sessionId);
    } catch {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const unsubscribe = service.subscribeEvents((event) => {
        if (event.session_id === sessionId) {
          ws.send(JSON.stringify(event));
        }
      });
      ws.on("close", () => unsubscribe());
    });
  });

  const [host, port] = splitBindAddr(config.bindAddr);

  return {
    service,
    config,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    async close() {
      clearInterval(cleanupTimer);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      service.close();
    }
  };
}

function wrapJson(
  handler: (req: express.Request, res: express.Response) => Promise<unknown>
): express.RequestHandler {
  return async (req, res) => {
    try {
      const payload = await handler(req, res);
      if (res.headersSent) {
        return;
      }
      if (res.statusCode === 204) {
        res.end();
        return;
      }
      res.json(payload);
    } catch (error) {
      sendError(res, error);
    }
  };
}

function sendError(res: express.Response, error: unknown): void {
  const httpError = normalizeHttpError(error);
  res.status(httpError.status).json({ error: httpError.message });
}

function normalizeHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof SyntaxError) {
    return new HttpError(400, error.message);
  }
  if (error instanceof Error) {
    return new HttpError(500, error.message);
  }
  return new HttpError(500, String(error));
}

function splitBindAddr(bindAddr: string): [string, number] {
  const [host, rawPort] = bindAddr.split(":");
  return [host ?? "127.0.0.1", Number.parseInt(rawPort ?? "3000", 10)];
}

function queryStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return null;
}

function param(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  throw new HttpError(400, "missing route parameter");
}
