import WebSocket from "ws";

import type {
  EvalResponse,
  PageSnapshot,
  ScreenshotRequest,
  ServerEvent,
  TabRecord
} from "../types.js";

const STEALTH_SOURCE = `
(() => {
  if (globalThis.__tbrowserStealthApplied) {
    return;
  }

  Object.defineProperty(globalThis, "__tbrowserStealthApplied", {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });

  const defineValue = (target, property, value) => {
    try {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: false,
        value,
        writable: true,
      });
    } catch (_) {}
  };

  const defineGetter = (target, property, getter) => {
    try {
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: false,
        get: getter,
      });
    } catch (_) {}
  };

  defineGetter(Navigator.prototype, "webdriver", () => undefined);

  if (navigator.permissions?.query) {
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (parameters) => {
      if (parameters?.name === "notifications") {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return originalQuery(parameters);
    };
  }

  if (!globalThis.chrome) {
    defineValue(globalThis, "chrome", {});
  }

  if (globalThis.chrome && !globalThis.chrome.runtime) {
    defineValue(globalThis.chrome, "runtime", {
      connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {} }),
      sendMessage: () => {},
      id: undefined,
    });
  }

  if (globalThis.chrome && !globalThis.chrome.app) {
    defineValue(globalThis.chrome, "app", {
      InstallState: {
        DISABLED: "disabled",
        INSTALLED: "installed",
        NOT_INSTALLED: "not_installed",
      },
      RunningState: {
        CANNOT_RUN: "cannot_run",
        READY_TO_RUN: "ready_to_run",
        RUNNING: "running",
      },
      getDetails: () => null,
      getIsInstalled: () => false,
      runningState: () => "cannot_run",
    });
  }
})();
`;

interface TargetInfo {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  type: string;
}

interface VersionInfo {
  webSocketDebuggerUrl?: string;
}

export interface ScreenshotArtifact {
  bytes: Buffer;
  contentType: string;
}

export class CdpClient {
  readonly #baseHttpUrl: string;

  public constructor(baseHttpUrl: string) {
    this.#baseHttpUrl = baseHttpUrl;
  }

  public async navigate(url: string): Promise<void> {
    const websocketUrl = await this.pageWebsocketUrl();
    const session = await CdpCommandSession.connect(websocketUrl);
    try {
      await this.configureStealth(session);
      await session.command("Page.enable", {});
      await session.command("Runtime.enable", {});
      await session.command("Page.navigate", { url });
      await session.waitForEvent("Page.loadEventFired", 20_000);
    } finally {
      session.close();
    }
  }

  public async evaluate(expression: string, awaitPromise: boolean, returnByValue: boolean): Promise<EvalResponse> {
    const websocketUrl = await this.pageWebsocketUrl();
    const session = await CdpCommandSession.connect(websocketUrl);
    try {
      await this.configureStealth(session);
      await session.command("Runtime.enable", {});
      const response = await session.command("Runtime.evaluate", {
        expression,
        awaitPromise,
        returnByValue
      });
      const value =
        response.result?.result?.value ??
        response.result?.result?.description ??
        null;
      return { value };
    } finally {
      session.close();
    }
  }

  public async snapshot(): Promise<PageSnapshot> {
    const evaluation = await this.evaluate(
      "(() => ({ url: location.href, title: document.title, html: document.documentElement.outerHTML }))()",
      true,
      true
    );
    return evaluation.value as unknown as PageSnapshot;
  }

  public async screenshot(request: ScreenshotRequest): Promise<ScreenshotArtifact> {
    const websocketUrl = await this.pageWebsocketUrl();
    const session = await CdpCommandSession.connect(websocketUrl);
    try {
      await this.configureStealth(session);
      await session.command("Page.enable", {});
      const format = request.format ?? "png";
      const params: Record<string, unknown> = {
        format,
        captureBeyondViewport: request.full_page ?? false
      };
      if (request.quality !== undefined && request.quality !== null) {
        params.quality = request.quality;
      }
      const response = await session.command("Page.captureScreenshot", params);
      const encoded = response.result?.data;
      if (typeof encoded !== "string") {
        throw new Error("screenshot data missing from CDP response");
      }
      return {
        bytes: Buffer.from(encoded, "base64"),
        contentType: format === "jpeg" ? "image/jpeg" : "image/png"
      };
    } finally {
      session.close();
    }
  }

  public async installStealth(): Promise<void> {
    const websocketUrl = await this.pageWebsocketUrl();
    const session = await CdpCommandSession.connect(websocketUrl);
    try {
      await this.configureStealth(session);
    } finally {
      session.close();
    }
  }

  public async listTabs(): Promise<TabRecord[]> {
    const targets = await this.targets();
    return targets
      .filter((target) => target.type === "page")
      .map((target) => ({
        id: target.id,
        title: target.title,
        url: target.url,
        target_type: target.type
      }));
  }

  public async createTab(url?: string | null): Promise<TabRecord> {
    const browserWs = await this.browserWebsocketUrl();
    const session = await CdpCommandSession.connect(browserWs);
    try {
      const response = await session.command("Target.createTarget", {
        url: url ?? "about:blank"
      });
      const id = response.result?.targetId;
      if (typeof id !== "string") {
        throw new Error("Target.createTarget response did not include targetId");
      }
      const tabs = await this.listTabs();
      const created = tabs.find((tab) => tab.id === id);
      if (!created) {
        throw new Error(`created tab ${id} was not visible in target list`);
      }
      return created;
    } finally {
      session.close();
    }
  }

  public async activateTab(tabId: string): Promise<void> {
    const browserWs = await this.browserWebsocketUrl();
    const session = await CdpCommandSession.connect(browserWs);
    try {
      await session.command("Target.activateTarget", { targetId: tabId });
    } finally {
      session.close();
    }
  }

  public async closeTab(tabId: string): Promise<void> {
    const browserWs = await this.browserWebsocketUrl();
    const session = await CdpCommandSession.connect(browserWs);
    try {
      await session.command("Target.closeTarget", { targetId: tabId });
    } finally {
      session.close();
    }
  }

  public async configureDownloads(downloadDir: string): Promise<void> {
    const browserWs = await this.browserWebsocketUrl();
    const session = await CdpCommandSession.connect(browserWs);
    try {
      await session.command("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadDir,
        eventsEnabled: true
      });
    } finally {
      session.close();
    }
  }

  public async setFileInputFiles(selector: string, files: string[]): Promise<void> {
    const websocketUrl = await this.pageWebsocketUrl();
    const session = await CdpCommandSession.connect(websocketUrl);
    try {
      await this.configureStealth(session);
      await session.command("DOM.enable", {});
      const document = await session.command("DOM.getDocument", {});
      const rootNodeId = document.result?.root?.nodeId;
      if (typeof rootNodeId !== "number") {
        throw new Error("DOM.getDocument did not return a root node");
      }
      const nodeResponse = await session.command("DOM.querySelector", {
        nodeId: rootNodeId,
        selector
      });
      const nodeId = nodeResponse.result?.nodeId;
      if (typeof nodeId !== "number" || nodeId === 0) {
        throw new Error(`selector did not match an input element: ${selector}`);
      }
      await session.command("DOM.setFileInputFiles", {
        nodeId,
        files
      });
    } finally {
      session.close();
    }
  }

  public async captureNetwork(durationMs: number): Promise<Buffer> {
    const websocketUrl = await this.pageWebsocketUrl();
    const session = await CdpCommandSession.connect(websocketUrl);
    try {
      await this.configureStealth(session);
      await session.command("Network.enable", {});
      await session.command("Page.enable", {});
      const startedAt = Date.now();
      const events: unknown[] = [];
      while (Date.now() - startedAt < durationMs) {
        const remaining = durationMs - (Date.now() - startedAt);
        if (remaining <= 0) {
          break;
        }
        try {
          const frame = await session.nextJsonFrameTimeout(remaining);
          const method = typeof frame.method === "string" ? frame.method : "";
          if (method.startsWith("Network.") || method === "Page.downloadWillBegin") {
            events.push(frame);
          }
        } catch (error) {
          if (error instanceof Error && error.message.includes("timed out")) {
            break;
          }
          throw error;
        }
      }
      return Buffer.from(
        JSON.stringify(
          {
            captured_at: new Date().toISOString(),
            duration_ms: durationMs,
            events
          },
          null,
          2
        ),
        "utf8"
      );
    } finally {
      session.close();
    }
  }

  public async captureTrace(durationMs: number, categories: string[]): Promise<Buffer> {
    const browserWs = await this.browserWebsocketUrl();
    const session = await CdpCommandSession.connect(browserWs);
    const joined = categories.length === 0 ? "devtools.timeline,blink.user_timing,v8.execute" : categories.join(",");
    try {
      await session.command("Tracing.start", {
        categories: joined,
        transferMode: "ReportEvents"
      });
      await sleep(durationMs);
      await session.command("Tracing.end", {});
      const deadline = Date.now() + 10_000;
      const chunks: unknown[] = [];
      while (Date.now() < deadline) {
        const frame = await session.nextJsonFrameTimeout(Math.max(1, deadline - Date.now()));
        if (frame.method === "Tracing.dataCollected" && Array.isArray(frame.params?.value)) {
          chunks.push(...frame.params.value);
        }
        if (frame.method === "Tracing.tracingComplete") {
          break;
        }
      }
      return Buffer.from(
        JSON.stringify(
          {
            captured_at: new Date().toISOString(),
            duration_ms: durationMs,
            trace_events: chunks
          },
          null,
          2
        ),
        "utf8"
      );
    } finally {
      session.close();
    }
  }

  private async pageWebsocketUrl(): Promise<string> {
    const targets = await this.targets();
    const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error("no page target with websocket debugger URL was available");
    }
    return target.webSocketDebuggerUrl;
  }

  private async browserWebsocketUrl(): Promise<string> {
    const version = (await this.fetchJson("/json/version")) as VersionInfo;
    if (!version.webSocketDebuggerUrl) {
      throw new Error("browser websocket debugger URL was not available");
    }
    return version.webSocketDebuggerUrl;
  }

  private async targets(): Promise<TargetInfo[]> {
    return (await this.fetchJson("/json/list")) as TargetInfo[];
  }

  private async fetchJson(path: string): Promise<unknown> {
    const url = `${this.#baseHttpUrl.replace(/\/+$/, "")}${path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`browser returned error for ${path}: ${response.status}`);
    }
    return response.json();
  }

  private async configureStealth(session: CdpCommandSession): Promise<void> {
    await session.command("Page.enable", {});
    await session.command("Runtime.enable", {});
    await session.command("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_SOURCE });
    await session.command("Runtime.evaluate", {
      expression: STEALTH_SOURCE,
      awaitPromise: true,
      returnByValue: false
    });
  }
}

class CdpCommandSession {
  readonly #socket: WebSocket;
  readonly #frames: unknown[] = [];
  readonly #waiters: Array<(value: unknown) => void> = [];
  readonly #pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; method: string }>();
  #nextId = 1;

  public static async connect(websocketUrl: string): Promise<CdpCommandSession> {
    const socket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(websocketUrl);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
    return new CdpCommandSession(socket);
  }

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (message) => {
      const raw = typeof message === "string" ? message : message.toString();
      const frame = JSON.parse(raw) as Record<string, any>;
      const id = typeof frame.id === "number" ? frame.id : null;
      if (id !== null) {
        const pending = this.#pending.get(id);
        if (pending) {
          this.#pending.delete(id);
          if (frame.error) {
            pending.reject(new Error(`CDP command ${pending.method} failed: ${JSON.stringify(frame.error)}`));
          } else {
            pending.resolve(frame);
          }
          return;
        }
      }
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter(frame);
      } else {
        this.#frames.push(frame);
      }
    });
    socket.on("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("websocket closed before command completed"));
      }
      this.#pending.clear();
    });
  }

  public async command(method: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const id = this.#nextId++;
    const payload = JSON.stringify({ id, method, params });
    const response = new Promise<Record<string, any>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
    });
    this.#socket.send(payload);
    return response;
  }

  public async waitForEvent(method: string, durationMs: number): Promise<Record<string, any>> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const frame = await this.nextJsonFrameTimeout(Math.max(1, deadline - Date.now()));
      if (frame.method === method) {
        return frame;
      }
    }
    throw new Error(`timed out waiting for CDP event ${method}`);
  }

  public async nextJsonFrameTimeout(durationMs: number): Promise<Record<string, any>> {
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for CDP frame")), durationMs);
      this.nextJsonFrame()
        .then((frame) => {
          clearTimeout(timer);
          resolve(frame);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  public async nextJsonFrame(): Promise<Record<string, any>> {
    if (this.#frames.length > 0) {
      return this.#frames.shift() as Record<string, any>;
    }
    return new Promise<Record<string, any>>((resolve) => {
      this.#waiters.push((frame) => resolve(frame as Record<string, any>));
    });
  }

  public close(): void {
    this.#socket.close();
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
