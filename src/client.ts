import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import mime from "mime-types";
import WebSocket from "ws";

import type {
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequest,
  ArtifactRecord,
  BinaryResponse,
  CreateSessionRequest,
  CreateTabRequest,
  DesktopClickRequest,
  DesktopDragRequest,
  DesktopMoveRequest,
  DownloadToPathResult,
  ElementDragRequest,
  ElementDragResponse,
  EvalRequest,
  EvalResponse,
  ExportProfileRequest,
  ImportProfileRequest,
  InputActionResponse,
  JsonValue,
  KeyPressRequest,
  LiveViewResponse,
  NavigateRequest,
  NetworkCaptureRequest,
  PageSnapshot,
  PolicyRuleSet,
  ProfileExportResponse,
  ProfileImportResponse,
  ProfileRecord,
  RequestOptions,
  ScreenshotRequest,
  ServerEvent,
  SessionRecord,
  TabRecord,
  TbrowserClientOptions,
  TraceCaptureRequest,
  TypeTextRequest,
  UploadFileRequest,
  UploadFileResponse,
  UploadFromPathRequest,
  UploadTextRequest,
  WaitForDownloadRequest
} from "./types.js";

export class TbrowserApiError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly url: string;
  public readonly body: unknown;

  public constructor(message: string, options: { status: number; statusText: string; url: string; body: unknown }) {
    super(message);
    this.name = "TbrowserApiError";
    this.status = options.status;
    this.statusText = options.statusText;
    this.url = options.url;
    this.body = options.body;
  }
}

export class TbrowserSessionEventStream extends EventEmitter {
  public readonly sessionId: string;
  public readonly url: string;
  readonly #socket: WebSocket;
  readonly #opened: Promise<void>;

  public constructor(sessionId: string, url: string, headers?: Record<string, string>) {
    super();
    this.sessionId = sessionId;
    this.url = url;
    this.#socket = new WebSocket(url, {
      headers
    });
    this.#opened = new Promise((resolve, reject) => {
      this.#socket.once("open", () => {
        this.emit("open");
        resolve();
      });
      this.#socket.once("error", (error) => {
        reject(error);
      });
    });

    this.#socket.on("message", (payload) => {
      try {
        const event = JSON.parse(payload.toString()) as ServerEvent;
        this.emit("event", event);
      } catch (error) {
        this.emit("error", error);
      }
    });
    this.#socket.on("error", (error) => {
      this.emit("error", error);
    });
    this.#socket.on("close", (code, reason) => {
      this.emit("close", { code, reason: reason.toString() });
    });
  }

  public async waitUntilOpen(): Promise<void> {
    await this.#opened;
  }

  public close(code?: number, reason?: string): void {
    this.#socket.close(code, reason);
  }
}

export class TbrowserClient {
  public readonly baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  public constructor(options: TbrowserClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:3000");
    this.#fetch = options.fetch ?? fetch;
    this.#headers = { ...(options.headers ?? {}) };
  }

  public async health(options?: RequestOptions): Promise<string> {
    const response = await this.#fetch(this.#url("/healthz"), this.#requestInit("GET", undefined, options));
    if (!response.ok) {
      throw await buildApiError(response);
    }
    return response.text();
  }

  public getPolicy(options?: RequestOptions): Promise<PolicyRuleSet> {
    return this.#json("GET", "/v1/policy", undefined, options);
  }

  public listProfiles(options?: RequestOptions): Promise<ProfileRecord[]> {
    return this.#json("GET", "/v1/profiles", undefined, options);
  }

  public getProfile(profileId: string, options?: RequestOptions): Promise<ProfileRecord> {
    return this.#json("GET", `/v1/profiles/${encodeURIComponent(profileId)}`, undefined, options);
  }

  public importProfile(request: ImportProfileRequest, options?: RequestOptions): Promise<ProfileImportResponse> {
    return this.#json("POST", "/v1/profiles/import", request, options);
  }

  public exportProfile(
    profileId: string,
    request: ExportProfileRequest,
    options?: RequestOptions
  ): Promise<ProfileExportResponse> {
    return this.#json("POST", `/v1/profiles/${encodeURIComponent(profileId)}/export`, request, options);
  }

  public listSessions(options?: RequestOptions): Promise<SessionRecord[]> {
    return this.#json("GET", "/v1/sessions", undefined, options);
  }

  public createSession(request: CreateSessionRequest, options?: RequestOptions): Promise<SessionRecord> {
    return this.#json("POST", "/v1/sessions", request, options);
  }

  public getSession(sessionId: string, options?: RequestOptions): Promise<SessionRecord> {
    return this.#json("GET", this.#sessionPath(sessionId), undefined, options);
  }

  public closeSession(sessionId: string, options?: RequestOptions): Promise<SessionRecord> {
    return this.#json("DELETE", this.#sessionPath(sessionId), undefined, options);
  }

  public getLiveView(sessionId: string, options?: RequestOptions): Promise<LiveViewResponse> {
    return this.#json("GET", `${this.#sessionPath(sessionId)}/live`, undefined, options);
  }

  public navigate(sessionId: string, request: NavigateRequest, options?: RequestOptions): Promise<SessionRecord> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/navigate`, request, options);
  }

  public evaluate<TValue = JsonValue>(
    sessionId: string,
    request: EvalRequest,
    options?: RequestOptions
  ): Promise<EvalResponse<TValue>> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/eval`, request, options);
  }

  public snapshot(sessionId: string, options?: RequestOptions): Promise<PageSnapshot> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/snapshot`, undefined, options);
  }

  public async screenshot(
    sessionId: string,
    request: ScreenshotRequest = {},
    options?: RequestOptions
  ): Promise<BinaryResponse> {
    return this.#binary("POST", `${this.#sessionPath(sessionId)}/screenshot`, request, options);
  }

  public async saveScreenshot(
    sessionId: string,
    destinationPath: string,
    request: ScreenshotRequest = {},
    options?: RequestOptions
  ): Promise<string> {
    const response = await this.screenshot(sessionId, request, options);
    await writeBuffer(destinationPath, response.data);
    return destinationPath;
  }

  public listEvents(sessionId: string, options?: RequestOptions): Promise<import("./types.js").AuditEventRecord[]> {
    return this.#json("GET", `${this.#sessionPath(sessionId)}/events`, undefined, options);
  }

  public subscribeSessionEvents(sessionId: string): TbrowserSessionEventStream {
    const url = this.#url(`${this.#sessionPath(sessionId)}/events/ws`).replace(/^http/i, "ws");
    return new TbrowserSessionEventStream(sessionId, url, this.#headers);
  }

  public listApprovals(sessionId: string, options?: RequestOptions): Promise<ApprovalRecord[]> {
    return this.#json("GET", `${this.#sessionPath(sessionId)}/approvals`, undefined, options);
  }

  public createApproval(
    sessionId: string,
    request: ApprovalRequest,
    options?: RequestOptions
  ): Promise<ApprovalRecord> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/approvals`, request, options);
  }

  public decideApproval(
    approvalId: string,
    request: ApprovalDecisionRequest,
    options?: RequestOptions
  ): Promise<ApprovalRecord> {
    return this.#json("POST", `/v1/approvals/${encodeURIComponent(approvalId)}/decision`, request, options);
  }

  public listArtifacts(sessionId: string, options?: RequestOptions): Promise<ArtifactRecord[]> {
    return this.#json("GET", `${this.#sessionPath(sessionId)}/artifacts`, undefined, options);
  }

  public downloadArtifact(sessionId: string, artifactId: string, options?: RequestOptions): Promise<BinaryResponse> {
    return this.#binary(
      "GET",
      `${this.#sessionPath(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
      undefined,
      options
    );
  }

  public async downloadArtifactToPath(
    sessionId: string,
    artifactId: string,
    destinationPath: string,
    options?: RequestOptions
  ): Promise<string> {
    const response = await this.downloadArtifact(sessionId, artifactId, options);
    await writeBuffer(destinationPath, response.data);
    return destinationPath;
  }

  public listTabs(sessionId: string, options?: RequestOptions): Promise<TabRecord[]> {
    return this.#json("GET", `${this.#sessionPath(sessionId)}/tabs`, undefined, options);
  }

  public createTab(sessionId: string, request: CreateTabRequest = {}, options?: RequestOptions): Promise<TabRecord> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/tabs`, request, options);
  }

  public async activateTab(sessionId: string, tabId: string, options?: RequestOptions): Promise<void> {
    await this.#empty("POST", `${this.#sessionPath(sessionId)}/tabs/${encodeURIComponent(tabId)}/activate`, undefined, options);
  }

  public async closeTab(
    sessionId: string,
    tabId: string,
    approvalId?: string | null,
    options?: RequestOptions
  ): Promise<void> {
    const query = approvalId ? `?approval_id=${encodeURIComponent(approvalId)}` : "";
    await this.#empty(
      "POST",
      `${this.#sessionPath(sessionId)}/tabs/${encodeURIComponent(tabId)}/close${query}`,
      undefined,
      options
    );
  }

  public uploadFile(sessionId: string, request: UploadFileRequest, options?: RequestOptions): Promise<UploadFileResponse> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/uploads`, request, options);
  }

  public async uploadFileFromPath(
    sessionId: string,
    request: UploadFromPathRequest,
    options?: RequestOptions
  ): Promise<UploadFileResponse> {
    const bytes = await readFile(request.path);
    const fileName = request.fileName ?? basename(request.path);
    const mimeType = request.mimeType ?? guessMimeType(fileName);
    return this.uploadFile(sessionId, compactObject({
      selector: request.selector,
      file_name: fileName,
      content_base64: bytes.toString("base64"),
      mime_type: mimeType,
      approval_id: request.approvalId
    }), options);
  }

  public uploadText(sessionId: string, request: UploadTextRequest, options?: RequestOptions): Promise<UploadFileResponse> {
    return this.uploadFile(sessionId, compactObject({
      selector: request.selector,
      file_name: request.fileName,
      content_base64: Buffer.from(request.text, "utf8").toString("base64"),
      mime_type: request.mimeType ?? guessMimeType(request.fileName) ?? "text/plain; charset=utf-8",
      approval_id: request.approvalId
    }), options);
  }

  public waitForDownload(sessionId: string, request: WaitForDownloadRequest = {}, options?: RequestOptions): Promise<ArtifactRecord> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/downloads/wait`, request, options);
  }

  public async waitForDownloadToPath(
    sessionId: string,
    destinationDir: string,
    request: WaitForDownloadRequest = {},
    options?: RequestOptions
  ): Promise<DownloadToPathResult> {
    const artifact = await this.waitForDownload(sessionId, request, options);
    const destinationPath = join(destinationDir, artifact.name);
    await this.downloadArtifactToPath(sessionId, artifact.id, destinationPath, options);
    return {
      artifact,
      destinationPath
    };
  }

  public captureNetwork(
    sessionId: string,
    request: NetworkCaptureRequest = {},
    options?: RequestOptions
  ): Promise<ArtifactRecord> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/captures/network`, request, options);
  }

  public captureTrace(sessionId: string, request: TraceCaptureRequest = {}, options?: RequestOptions): Promise<ArtifactRecord> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/captures/trace`, request, options);
  }

  public moveMouse(sessionId: string, request: DesktopMoveRequest, options?: RequestOptions): Promise<InputActionResponse> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/desktop/mouse/move`, request, options);
  }

  public clickMouse(sessionId: string, request: DesktopClickRequest, options?: RequestOptions): Promise<InputActionResponse> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/desktop/mouse/click`, request, options);
  }

  public dragMouse(sessionId: string, request: DesktopDragRequest, options?: RequestOptions): Promise<InputActionResponse> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/desktop/mouse/drag`, request, options);
  }

  public typeText(sessionId: string, request: TypeTextRequest, options?: RequestOptions): Promise<InputActionResponse> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/desktop/keyboard/type`, request, options);
  }

  public pressKey(sessionId: string, request: KeyPressRequest, options?: RequestOptions): Promise<InputActionResponse> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/desktop/keyboard/key`, request, options);
  }

  public dragElement(
    sessionId: string,
    request: ElementDragRequest,
    options?: RequestOptions
  ): Promise<ElementDragResponse> {
    return this.#json("POST", `${this.#sessionPath(sessionId)}/desktop/drag-element`, request, options);
  }

  public async requestJson<TResponse = JsonValue>(
    method: string,
    path: string,
    body?: JsonValue | object,
    options?: RequestOptions
  ): Promise<TResponse> {
    return this.#json(method, path, body, options);
  }

  public async requestBinary(
    method: string,
    path: string,
    body?: JsonValue | object,
    options?: RequestOptions
  ): Promise<BinaryResponse> {
    return this.#binary(method, path, body, options);
  }
  
  async #json<TResponse>(
    method: string,
    path: string,
    body?: JsonValue | object,
    options?: RequestOptions
  ): Promise<TResponse> {
    const response = await this.#request(method, path, body, options);
    if (!response.ok) {
      throw await buildApiError(response);
    }
    if (response.status === 204) {
      return undefined as TResponse;
    }
    return (await response.json()) as TResponse;
  }

  async #binary(
    method: string,
    path: string,
    body?: JsonValue | object,
    options?: RequestOptions
  ): Promise<BinaryResponse> {
    const response = await this.#request(method, path, body, options);
    if (!response.ok) {
      throw await buildApiError(response);
    }
    const data = Buffer.from(await response.arrayBuffer());
    return {
      data,
      contentType: response.headers.get("content-type"),
      fileName: parseFileName(response.headers.get("content-disposition"))
    };
  }

  async #empty(
    method: string,
    path: string,
    body?: JsonValue | object,
    options?: RequestOptions
  ): Promise<void> {
    const response = await this.#request(method, path, body, options);
    if (!response.ok) {
      throw await buildApiError(response);
    }
  }

  #request(
    method: string,
    path: string,
    body?: JsonValue | object,
    options?: RequestOptions
  ): Promise<Response> {
    return this.#fetch(this.#url(path), this.#requestInit(method, body, options));
  }

  #requestInit(method: string, body?: JsonValue | object, options?: RequestOptions): RequestInit {
    const init: RequestInit = {
      method,
      headers: this.#mergeHeaders(options)
    };
    if (options?.signal) {
      init.signal = options.signal;
    }
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = {
        "content-type": "application/json",
        ...(init.headers ?? {})
      };
    }
    return init;
  }

  #sessionPath(sessionId: string): string {
    return `/v1/sessions/${encodeURIComponent(sessionId)}`;
  }

  #url(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  #mergeHeaders(options?: RequestOptions): Record<string, string> {
    return {
      accept: "application/json",
      ...this.#headers,
      ...(options?.headers ?? {})
    };
  }
}

async function buildApiError(response: Response): Promise<TbrowserApiError> {
  let body: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  try {
    body = contentType.includes("application/json") ? await response.json() : await response.text();
  } catch {
    body = null;
  }
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `${response.status} ${response.statusText}`;
  return new TbrowserApiError(message, {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    body
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function parseFileName(contentDisposition: string | null): string | null {
  if (!contentDisposition) {
    return null;
  }
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
  if (utf8?.[1]) {
    return decodeURIComponent(utf8[1]);
  }
  const basic = /filename="?([^"]+)"?/i.exec(contentDisposition);
  return basic?.[1] ?? null;
}

function guessMimeType(fileName: string): string | null {
  const found = mime.lookup(fileName);
  return typeof found === "string" ? found : null;
}

async function writeBuffer(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  return Object.fromEntries(entries) as T;
}
