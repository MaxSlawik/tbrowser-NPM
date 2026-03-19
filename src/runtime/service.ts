import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { v4 as uuidv4 } from "uuid";

import type {
  ApprovalAction,
  ApprovalDecisionRequest,
  ApprovalRecord,
  ApprovalRequest,
  ArtifactRecord,
  AuditEventRecord,
  CreateSessionRequest,
  CreateTabRequest,
  DesktopClickRequest,
  DesktopDragRequest,
  DesktopMoveRequest,
  ElementDragRequest,
  ElementDragResponse,
  EvalRequest,
  EvalResponse,
  ExportProfileRequest,
  ImportProfileRequest,
  InputActionResponse,
  KeyPressRequest,
  LiveViewResponse,
  NavigateRequest,
  NetworkCaptureRequest,
  PageSnapshot,
  PolicyRuleSet,
  ProfileRecord,
  ProxyConfig,
  ScreenshotRequest,
  ServerEvent,
  SessionRecord,
  TabRecord,
  TraceCaptureRequest,
  TypeTextRequest,
  UploadFileRequest,
  UploadFileResponse,
  WaitForDownloadRequest
} from "../types.js";
import type { AppConfig } from "./config.js";
import { CdpClient } from "./cdp.js";
import { DockerRunner } from "./docker.js";
import {
  ensureSessionProfileDirectory,
  exportProfile,
  importProfile,
  listNamedProfileIds,
  namedProfileDir,
  summarizeProfileDir,
  validateProfileId
} from "./profiles.js";
import type { ArtifactInsert, PendingSessionInsert, RunningSessionUpdate } from "./store.js";
import { SessionStore } from "./store.js";

const DOWNLOADS_CONTAINER_DIR = "/data/artifacts/downloads";
const UPLOADS_CONTAINER_DIR = "/data/artifacts/uploads";

export class HttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export class BrowserService {
  readonly #config: AppConfig;
  readonly #store: SessionStore;
  readonly #runner: DockerRunner;
  readonly #events = new EventEmitter();
  #nextEventId = 1;

  public constructor(config: AppConfig) {
    this.#config = config;
    this.#store = new SessionStore(config.databasePath);
    this.#runner = new DockerRunner({
      image: config.browserImage,
      publicHost: config.publicHost
    });
  }

  public close(): void {
    this.#store.close();
  }

  public subscribeEvents(listener: (event: ServerEvent) => void): () => void {
    this.#events.on("event", listener);
    return () => {
      this.#events.off("event", listener);
    };
  }

  public policySnapshot(): PolicyRuleSet {
    return this.#config.policy;
  }

  public async createSession(request: CreateSessionRequest): Promise<SessionRecord> {
    this.validateCreateSessionRequest(request);
    if (request.initial_url) {
      this.enforceNavigationPolicy(request.initial_url);
    }

    const sessionId = uuidv4();
    const artifactDir = join(this.#config.dataDir, "artifacts", sessionId);
    const profileDir = await ensureSessionProfileDirectory(
      this.#config,
      sessionId,
      request.profile_id,
      request.profile_mode ?? "ephemeral"
    );
    await createSessionLayout(artifactDir);
    await ensureContainerWritable(artifactDir);
    await ensureContainerWritable(profileDir);

    const createdAt = nowString();
    const pending: PendingSessionInsert = {
      id: sessionId,
      label: request.label,
      created_at: createdAt,
      updated_at: createdAt,
      last_browser_action_at: null,
      expires_at: expiresAtString(request.ttl_seconds ?? null),
      initial_url: request.initial_url,
      ttl_seconds: request.ttl_seconds,
      profile_id: request.profile_id,
      profile_mode: request.profile_mode ?? "ephemeral",
      proxy: request.proxy ? redactProxy(request.proxy) : null,
      artifact_dir: artifactDir,
      profile_dir: profileDir
    };
    this.#store.insertPendingSession(pending);
    await this.recordAuditEvent(sessionId, "session.create.requested", sanitizeCreateRequest(request));

    const proxyAuthFile = await this.writeProxyAuthFile(artifactDir, request.proxy);
    const liveViewPassword = request.launch?.headless ? null : uuidv4().replaceAll("-", "");
    const liveViewPasswordFile = liveViewPassword
      ? await this.writeLiveViewPasswordFile(artifactDir, liveViewPassword)
      : null;

    try {
      const launched = await this.#runner.launchSession({
        sessionId,
        initialUrl: null,
        profileDir,
        profileReadOnly: (request.profile_mode ?? "ephemeral") === "read_only",
        artifactDir,
        proxy: request.proxy ?? null,
        proxyAuthFile,
        liveViewPasswordFile,
        launch: request.launch ?? {}
      });
      const cdp = new CdpClient(launched.cdpHttpUrl);
      await cdp.installStealth();
      await cdp.configureDownloads(DOWNLOADS_CONTAINER_DIR);
      if (request.initial_url) {
        await cdp.navigate(request.initial_url);
      }

      const running: RunningSessionUpdate = {
        updated_at: nowString(),
        last_browser_action_at: nowString(),
        container_id: launched.containerId,
        debug_port: launched.debugPort,
        vnc_port: launched.vncPort,
        live_view_port: launched.liveViewPort,
        cdp_http_url: launched.cdpHttpUrl,
        live_view_url: launched.liveViewUrl ? buildLiveViewUrl(launched.liveViewUrl, liveViewPassword ?? "") : null
      };
      this.#store.markRunning(sessionId, running);
      await this.recordAuditEvent(sessionId, "session.create.ready", auditDetail("browser container is ready"));
      const session = this.getSession(sessionId);
      this.emitSessionEvent(session);
      return session;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#store.markFailed(sessionId, message);
      await this.recordAuditEvent(sessionId, "session.create.failed", auditDetail(message));
      const session = this.getSession(sessionId);
      this.emitSessionEvent(session);
      throw new HttpError(502, message);
    }
  }

  public listSessions(): SessionRecord[] {
    return this.#store.listSessions();
  }

  public getSession(sessionId: string): SessionRecord {
    const session = this.#store.getSession(sessionId);
    if (!session) {
      throw new HttpError(404, `session not found: ${sessionId}`);
    }
    return session;
  }

  public async closeSession(sessionId: string): Promise<SessionRecord> {
    const session = this.getSession(sessionId);
    if (session.status === "closed") {
      return session;
    }

    this.#store.markClosing(sessionId);
    await this.recordAuditEvent(sessionId, "session.close.requested", auditDetail("closing browser session"));

    let lastError: string | null = null;
    if (session.container_id) {
      try {
        await this.#runner.prepareHostCleanup(session.container_id, ["/data/profile", "/data/artifacts"]);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      try {
        await this.#runner.destroySession(session.container_id);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    this.#store.markClosed(sessionId, lastError);
    await this.recordAuditEvent(sessionId, "session.close.complete", auditDetail(lastError ?? "session closed"));
    const closed = this.getSession(sessionId);
    this.emitSessionEvent(closed);
    return closed;
  }

  public async liveView(sessionId: string): Promise<LiveViewResponse> {
    const session = this.requireRunningSession(sessionId);
    if (!session.cdp_http_url) {
      throw new HttpError(502, `session ${sessionId} does not have a CDP endpoint`);
    }
    return {
      session_id: sessionId,
      live_view_url: session.live_view_url,
      cdp_http_url: session.cdp_http_url
    };
  }

  public async navigate(sessionId: string, request: NavigateRequest): Promise<SessionRecord> {
    const session = this.requireRunningSession(sessionId);
    this.enforceNavigationPolicy(request.url);
    await this.requireApprovalIfNeeded(session, "navigate", request.approval_id, request.url);
    await this.cdp(session).navigate(request.url);
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "browser.navigate", { url: request.url });
    const current = this.getSession(sessionId);
    this.emitSessionEvent(current);
    return current;
  }

  public async evaluate(sessionId: string, request: EvalRequest): Promise<EvalResponse> {
    const session = this.requireRunningSession(sessionId);
    const needsSensitiveApproval = this.#config.policy.sensitive_eval_keywords.some((keyword) =>
      request.expression.includes(keyword)
    );
    await this.requireApprovalIfNeeded(
      session,
      needsSensitiveApproval ? "sensitive_eval" : null,
      request.approval_id,
      null
    );
    const response = await this.cdp(session).evaluate(
      request.expression,
      request.await_promise ?? true,
      request.return_by_value ?? true
    );
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "browser.eval", {
      expression_preview: request.expression.slice(0, 160),
      await_promise: request.await_promise ?? true,
      return_by_value: request.return_by_value ?? true
    });
    return response;
  }

  public async snapshot(sessionId: string): Promise<PageSnapshot> {
    const session = this.requireRunningSession(sessionId);
    const snapshot = await this.cdp(session).snapshot();
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "browser.snapshot", {
      url: snapshot.url,
      title: snapshot.title
    });
    return snapshot;
  }

  public async screenshot(sessionId: string, request: ScreenshotRequest): Promise<{ artifact: ArtifactRecord; bytes: Buffer }> {
    const session = this.requireRunningSession(sessionId);
    const artifact = await this.cdp(session).screenshot(request);
    const extension = request.format === "jpeg" ? "jpg" : "png";
    const artifactPath = join(session.artifact_dir, "screenshots", `${timestampSlug()}-${uuidv4()}.${extension}`);
    await mkdir(join(session.artifact_dir, "screenshots"), { recursive: true });
    await writeFile(artifactPath, artifact.bytes);
    const record = this.insertArtifact({
      id: uuidv4(),
      session_id: sessionId,
      kind: "screenshot",
      name: basename(artifactPath),
      path: artifactPath,
      content_type: artifact.contentType,
      size_bytes: artifact.bytes.byteLength,
      created_at: nowString(),
      metadata: {
        request
      }
    });
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "browser.screenshot", {
      artifact_id: record.id,
      path: artifactPath
    });
    return { artifact: record, bytes: artifact.bytes };
  }

  public listAuditEvents(sessionId: string): AuditEventRecord[] {
    this.getSession(sessionId);
    return this.#store.listAuditEvents(sessionId);
  }

  public listApprovals(sessionId: string): ApprovalRecord[] {
    this.getSession(sessionId);
    return this.#store.listApprovals(sessionId).map((approval) => this.refreshApprovalExpiry(approval));
  }

  public async createApproval(sessionId: string, request: ApprovalRequest): Promise<ApprovalRecord> {
    this.getSession(sessionId);
    const created = this.#store.insertApproval({
      id: uuidv4(),
      session_id: sessionId,
      action: request.action,
      status: "pending",
      reason: request.reason,
      target_url: request.target_url,
      requested_at: nowString(),
      updated_at: nowString(),
      expires_at: expiresAtString(request.ttl_seconds ?? this.#config.approvalTtlSeconds),
      reviewer: null,
      note: null
    });
    await this.recordAuditEvent(sessionId, "approval.create", {
      approval_id: created.id,
      action: created.action,
      target_url: created.target_url
    });
    return created;
  }

  public async decideApproval(approvalId: string, request: ApprovalDecisionRequest): Promise<ApprovalRecord> {
    const current = this.getApproval(approvalId);
    const approval = this.#store.updateApproval(approvalId, {
      status: request.approved ? "approved" : "denied",
      updated_at: nowString(),
      reviewer: request.reviewer ?? null,
      note: request.note ?? null
    });
    await this.recordAuditEvent(current.session_id, "approval.decision", {
      approval_id: approval.id,
      approved: request.approved,
      reviewer: request.reviewer ?? null
    });
    return approval;
  }

  public listArtifacts(sessionId: string): ArtifactRecord[] {
    this.getSession(sessionId);
    return this.#store.listArtifacts(sessionId);
  }

  public async readArtifact(sessionId: string, artifactId: string): Promise<{ contentType: string; bytes: Buffer }> {
    const artifact = this.#store.getArtifact(sessionId, artifactId);
    if (!artifact) {
      throw new HttpError(404, `artifact not found: ${artifactId}`);
    }
    const bytes = await readFile(artifact.path);
    return {
      contentType: artifact.content_type,
      bytes
    };
  }

  public async listTabs(sessionId: string): Promise<TabRecord[]> {
    const session = this.requireRunningSession(sessionId);
    return this.cdp(session).listTabs();
  }

  public async createTab(sessionId: string, request: CreateTabRequest): Promise<TabRecord> {
    const session = this.requireRunningSession(sessionId);
    await this.requireApprovalIfNeeded(session, "tab_create", request.approval_id, request.url ?? null);
    const tab = await this.cdp(session).createTab(request.url);
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "tab.create", {
      tab_id: tab.id,
      url: tab.url
    });
    return tab;
  }

  public async activateTab(sessionId: string, tabId: string): Promise<void> {
    const session = this.requireRunningSession(sessionId);
    await this.cdp(session).activateTab(tabId);
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "tab.activate", { tab_id: tabId });
  }

  public async closeTab(sessionId: string, tabId: string, approvalId?: string | null): Promise<void> {
    const session = this.requireRunningSession(sessionId);
    await this.requireApprovalIfNeeded(session, "tab_close", approvalId, null);
    await this.cdp(session).closeTab(tabId);
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "tab.close", { tab_id: tabId });
  }

  public async uploadFile(sessionId: string, request: UploadFileRequest): Promise<UploadFileResponse> {
    const session = this.requireRunningSession(sessionId);
    await this.requireApprovalIfNeeded(session, "upload", request.approval_id, null);
    const bytes = await this.resolveUploadBytes(request);
    const uploadsDir = join(session.artifact_dir, "uploads");
    await mkdir(uploadsDir, { recursive: true });
    const fileName = `${uuidv4()}-${sanitizeFileName(request.file_name)}`;
    const artifactPath = join(uploadsDir, fileName);
    await writeFile(artifactPath, bytes);
    await this.cdp(session).setFileInputFiles(request.selector, [`${UPLOADS_CONTAINER_DIR}/${fileName}`]);
    const artifact = this.insertArtifact({
      id: uuidv4(),
      session_id: sessionId,
      kind: "upload",
      name: request.file_name,
      path: artifactPath,
      content_type: request.mime_type ?? "application/octet-stream",
      size_bytes: bytes.byteLength,
      created_at: nowString(),
      metadata: {
        selector: request.selector,
        source_path: request.source_path ?? null
      }
    });
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "upload.complete", {
      artifact_id: artifact.id,
      file_name: request.file_name,
      selector: request.selector
    });
    return { artifact };
  }

  public async waitForDownload(sessionId: string, request: WaitForDownloadRequest): Promise<ArtifactRecord> {
    const session = this.requireRunningSession(sessionId);
    await this.requireApprovalIfNeeded(session, "download", request.approval_id, null);
    const downloadsDir = join(session.artifact_dir, "downloads");
    await mkdir(downloadsDir, { recursive: true });
    const deadline = Date.now() + (request.timeout_ms ?? 30_000);
    const settleMs = request.settle_ms ?? 750;
    const observations = new Map<string, { size: number; seenAt: number }>();

    while (Date.now() < deadline) {
      const files = await readdir(downloadsDir, { withFileTypes: true });
      for (const entry of files) {
        if (!entry.isFile() || entry.name.endsWith(".crdownload")) {
          continue;
        }
        const absolute = join(downloadsDir, entry.name);
        const details = await stat(absolute);
        const previous = observations.get(absolute);
        if (previous && previous.size === details.size && Date.now() - previous.seenAt >= settleMs) {
          const existing = this.#store.findArtifactByPath(sessionId, absolute);
          if (existing) {
            return existing;
          }
          const artifact = this.insertArtifact({
            id: uuidv4(),
            session_id: sessionId,
            kind: "download",
            name: entry.name,
            path: absolute,
            content_type: "application/octet-stream",
            size_bytes: details.size,
            created_at: nowString(),
            metadata: {}
          });
          this.#store.touchBrowserActivity(sessionId);
          await this.recordAuditEvent(sessionId, "download.complete", {
            artifact_id: artifact.id,
            path: absolute
          });
          return artifact;
        }
        observations.set(absolute, { size: details.size, seenAt: Date.now() });
      }
      await sleep(250);
    }
    throw new HttpError(504, `timed out waiting for download for session ${sessionId}`);
  }

  public async captureNetwork(sessionId: string, request: NetworkCaptureRequest): Promise<ArtifactRecord> {
    const session = this.requireRunningSession(sessionId);
    await this.requireApprovalIfNeeded(session, "network_capture", request.approval_id, null);
    const bytes = await this.cdp(session).captureNetwork(request.duration_ms ?? 5_000);
    const path = await this.writeArtifactBytes(session.artifact_dir, "captures", "network", "json", bytes);
    const artifact = this.insertArtifact({
      id: uuidv4(),
      session_id: sessionId,
      kind: "network_capture",
      name: basename(path),
      path,
      content_type: "application/json",
      size_bytes: bytes.byteLength,
      created_at: nowString(),
      metadata: {}
    });
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "capture.network", { artifact_id: artifact.id });
    return artifact;
  }

  public async captureTrace(sessionId: string, request: TraceCaptureRequest): Promise<ArtifactRecord> {
    const session = this.requireRunningSession(sessionId);
    await this.requireApprovalIfNeeded(session, "trace_capture", request.approval_id, null);
    const bytes = await this.cdp(session).captureTrace(request.duration_ms ?? 5_000, request.categories ?? []);
    const path = await this.writeArtifactBytes(session.artifact_dir, "captures", "trace", "json", bytes);
    const artifact = this.insertArtifact({
      id: uuidv4(),
      session_id: sessionId,
      kind: "trace",
      name: basename(path),
      path,
      content_type: "application/json",
      size_bytes: bytes.byteLength,
      created_at: nowString(),
      metadata: {
        categories: request.categories ?? []
      }
    });
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "capture.trace", { artifact_id: artifact.id });
    return artifact;
  }

  public async moveMouse(sessionId: string, request: DesktopMoveRequest): Promise<InputActionResponse> {
    const session = await this.requireDesktopSession(sessionId, request.approval_id);
    await this.#runner.moveMouse(session.container_id!, request.x, request.y);
    return this.completeInputAction(sessionId, "desktop.mouse.move", request);
  }

  public async clickMouse(sessionId: string, request: DesktopClickRequest): Promise<InputActionResponse> {
    const session = await this.requireDesktopSession(sessionId, request.approval_id);
    await this.#runner.clickMouse(
      session.container_id!,
      request.x,
      request.y,
      mouseButtonCode(request.button ?? "left"),
      request.clicks ?? 1,
      request.delay_ms ?? 80
    );
    return this.completeInputAction(sessionId, "desktop.mouse.click", request);
  }

  public async dragMouse(sessionId: string, request: DesktopDragRequest): Promise<InputActionResponse> {
    const session = await this.requireDesktopSession(sessionId, request.approval_id);
    await this.#runner.dragMouse(
      session.container_id!,
      request.start_x,
      request.start_y,
      request.end_x,
      request.end_y,
      mouseButtonCode(request.button ?? "left"),
      request.steps ?? 24,
      request.step_delay_ms ?? 12,
      request.hold_ms ?? 50
    );
    return this.completeInputAction(sessionId, "desktop.mouse.drag", request);
  }

  public async typeText(sessionId: string, request: TypeTextRequest): Promise<InputActionResponse> {
    const session = await this.requireDesktopSession(sessionId, request.approval_id);
    await this.#runner.typeText(session.container_id!, request.text, request.delay_ms ?? 25);
    return this.completeInputAction(sessionId, "desktop.keyboard.type", {
      text_preview: request.text.slice(0, 80)
    });
  }

  public async pressKey(sessionId: string, request: KeyPressRequest): Promise<InputActionResponse> {
    const session = await this.requireDesktopSession(sessionId, request.approval_id);
    await this.#runner.pressKey(session.container_id!, request.key);
    return this.completeInputAction(sessionId, "desktop.keyboard.key", request);
  }

  public async dragElement(sessionId: string, request: ElementDragRequest): Promise<ElementDragResponse> {
    const session = await this.requireDesktopSession(sessionId, request.approval_id);
    const expression = `(() => {
      const source = document.querySelector(${JSON.stringify(request.source_selector)});
      const target = document.querySelector(${JSON.stringify(request.target_selector)});
      if (!source || !target) {
        return null;
      }
      const sourceRect = source.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return {
        sourceX: Math.round(sourceRect.left + sourceRect.width / 2),
        sourceY: Math.round(sourceRect.top + sourceRect.height / 2),
        targetX: Math.round(targetRect.left + targetRect.width / 2),
        targetY: Math.round(targetRect.top + targetRect.height / 2)
      };
    })()`;
    const coordinates = (await this.cdp(session).evaluate(expression, true, true)).value as
      | { sourceX: number; sourceY: number; targetX: number; targetY: number }
      | null;
    if (!coordinates) {
      throw new HttpError(400, "could not resolve source and target elements");
    }
    await this.#runner.dragMouse(
      session.container_id!,
      coordinates.sourceX,
      coordinates.sourceY,
      coordinates.targetX,
      coordinates.targetY,
      "1",
      request.steps ?? 24,
      request.step_delay_ms ?? 12,
      request.hold_ms ?? 50
    );
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, "desktop.drag_element", {
      source_selector: request.source_selector,
      target_selector: request.target_selector
    });
    return {
      ok: true,
      source_x: coordinates.sourceX,
      source_y: coordinates.sourceY,
      target_x: coordinates.targetX,
      target_y: coordinates.targetY
    };
  }

  public async listProfiles(): Promise<ProfileRecord[]> {
    const ids = await listNamedProfileIds(this.#config);
    const profiles: ProfileRecord[] = [];
    for (const id of ids) {
      profiles.push(await summarizeProfileDir(id, namedProfileDir(this.#config, id), this.#store));
    }
    return profiles;
  }

  public async getProfile(profileId: string): Promise<ProfileRecord> {
    validateProfileId(profileId);
    const path = namedProfileDir(this.#config, profileId);
    return summarizeProfileDir(profileId, path, this.#store);
  }

  public async importProfile(request: ImportProfileRequest) {
    return importProfile(this.#config, this.#store, request);
  }

  public async exportProfile(profileId: string, request: ExportProfileRequest) {
    return exportProfile(this.#config, this.#store, profileId, request);
  }

  public async cleanupOnce(): Promise<void> {
    const now = Date.now();
    for (const session of this.#store.listSessions()) {
      if (!["creating", "running", "closing"].includes(session.status)) {
        continue;
      }
      const expired = session.expires_at ? Date.parse(session.expires_at) <= now : false;
      const idle = session.last_browser_action_at
        ? Date.parse(session.last_browser_action_at) + this.#config.idleTimeoutSeconds * 1000 <= now
        : false;
      if (expired || idle) {
        try {
          await this.closeSession(session.id);
        } catch {}
      }
    }
  }

  private requireRunningSession(sessionId: string): SessionRecord {
    const session = this.getSession(sessionId);
    if (!session.container_id || !session.cdp_http_url || session.status !== "running") {
      throw new HttpError(409, `session ${sessionId} is not running`);
    }
    return session;
  }

  private async requireDesktopSession(sessionId: string, approvalId?: string | null): Promise<SessionRecord> {
    const session = this.requireRunningSession(sessionId);
    if (!session.container_id || !session.live_view_url) {
      throw new HttpError(409, `session ${sessionId} is not a desktop session`);
    }
    await this.requireApprovalIfNeeded(session, "desktop", approvalId, null);
    return session;
  }

  private cdp(session: SessionRecord): CdpClient {
    if (!session.cdp_http_url) {
      throw new HttpError(502, `session ${session.id} does not expose CDP`);
    }
    return new CdpClient(session.cdp_http_url);
  }

  private async completeInputAction(sessionId: string, eventType: string, detail: unknown): Promise<InputActionResponse> {
    this.#store.touchBrowserActivity(sessionId);
    await this.recordAuditEvent(sessionId, eventType, detail);
    return { ok: true };
  }

  private validateCreateSessionRequest(request: CreateSessionRequest): void {
    if (request.profile_id) {
      validateProfileId(request.profile_id);
    }
    if ((request.profile_mode ?? "ephemeral") === "read_only" && !request.profile_id) {
      throw new HttpError(400, "read_only profile mode requires profile_id");
    }
  }

  private enforceNavigationPolicy(url: string): void {
    const hostname = hostnameForPolicy(url);
    if (!hostname) {
      return;
    }
    if (this.#config.policy.blocked_hosts.some((pattern) => hostMatches(hostname, pattern))) {
      throw new HttpError(403, `navigation blocked by policy for host ${hostname}`);
    }
  }

  private async requireApprovalIfNeeded(
    session: SessionRecord,
    action: ApprovalAction | null,
    approvalId?: string | null,
    targetUrl?: string | null
  ): Promise<void> {
    if (!action) {
      return;
    }
    const needsApproval =
      this.#config.policy.approval_actions.includes(action) ||
      (action === "navigate" && Boolean(targetUrl && this.requiresHostApproval(targetUrl)));
    if (!needsApproval) {
      return;
    }
    if (!approvalId) {
      throw new HttpError(428, `approval required for action ${action}`);
    }
    const approval = this.refreshApprovalExpiry(this.getApproval(approvalId));
    if (approval.session_id !== session.id) {
      throw new HttpError(403, `approval ${approvalId} does not belong to session ${session.id}`);
    }
    if (approval.action !== action) {
      throw new HttpError(403, `approval ${approvalId} does not cover action ${action}`);
    }
    if (approval.status !== "approved") {
      throw new HttpError(428, `approval ${approvalId} is not approved`);
    }
  }

  private requiresHostApproval(url: string): boolean {
    const hostname = hostnameForPolicy(url);
    if (!hostname) {
      return false;
    }
    return this.#config.policy.approval_hosts.some((pattern) => hostMatches(hostname, pattern));
  }

  private getApproval(approvalId: string): ApprovalRecord {
    const approval = this.#store.getApproval(approvalId);
    if (!approval) {
      throw new HttpError(404, `approval not found: ${approvalId}`);
    }
    return approval;
  }

  private refreshApprovalExpiry(approval: ApprovalRecord): ApprovalRecord {
    if (approval.status === "pending" && approval.expires_at && Date.parse(approval.expires_at) <= Date.now()) {
      return this.#store.updateApproval(approval.id, {
        status: "expired",
        updated_at: nowString()
      });
    }
    return approval;
  }

  private async resolveUploadBytes(request: UploadFileRequest): Promise<Buffer> {
    if (request.content_base64) {
      return Buffer.from(request.content_base64, "base64");
    }
    if (request.source_path) {
      return readFile(request.source_path);
    }
    throw new HttpError(400, "upload request requires content_base64 or source_path");
  }

  private async writeArtifactBytes(
    artifactDir: string,
    subdir: string,
    prefix: string,
    extension: string,
    bytes: Buffer
  ): Promise<string> {
    const dir = join(artifactDir, subdir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${prefix}-${timestampSlug()}-${uuidv4()}.${extension}`);
    await writeFile(path, bytes);
    return path;
  }

  private insertArtifact(input: ArtifactInsert): ArtifactRecord {
    const artifact = this.#store.insertArtifact(input);
    this.emitEvent("artifact", input.session_id, artifact);
    return artifact;
  }

  private async recordAuditEvent(sessionId: string, eventType: string, detail: unknown): Promise<AuditEventRecord> {
    const event = this.#store.insertAuditEvent(sessionId, eventType, detail);
    this.emitEvent("audit", sessionId, event);
    return event;
  }

  private emitSessionEvent(session: SessionRecord): void {
    this.emitEvent("session", session.id, session);
  }

  private emitEvent(kind: string, sessionId: string | null, payload: unknown): void {
    const event: ServerEvent = {
      id: this.#nextEventId++,
      kind,
      session_id: sessionId,
      created_at: nowString(),
      payload: payload as ServerEvent["payload"]
    };
    this.#events.emit("event", event);
  }

  private async writeProxyAuthFile(artifactDir: string, proxy?: ProxyConfig | null): Promise<string | null> {
    if (!proxy?.username && !proxy?.password) {
      return null;
    }
    const path = join(artifactDir, "proxy-auth.json");
    await writeFile(
      path,
      JSON.stringify({
        username: proxy.username ?? "",
        password: proxy.password ?? ""
      })
    );
    return path;
  }

  private async writeLiveViewPasswordFile(artifactDir: string, password: string): Promise<string> {
    const path = join(artifactDir, "live-view-password.txt");
    await writeFile(path, password);
    return path;
  }
}

function nowString(): string {
  return new Date().toISOString();
}

function expiresAtString(ttlSeconds: number | null): string | null {
  if (!ttlSeconds) {
    return null;
  }
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function timestampSlug(): string {
  return nowString().replaceAll(":", "").replaceAll(".", "").replace("T", "-").replace("Z", "");
}

function hostnameForPolicy(url: string): string | null {
  if (url.startsWith("about:") || url.startsWith("data:")) {
    return null;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    throw new HttpError(400, `invalid URL: ${url}`);
  }
}

function hostMatches(hostname: string, pattern: string): boolean {
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(1);
    return hostname.endsWith(suffix);
  }
  return hostname === normalizedPattern;
}

function sanitizeCreateRequest(request: CreateSessionRequest): unknown {
  return {
    label: request.label ?? null,
    initial_url: request.initial_url ?? null,
    ttl_seconds: request.ttl_seconds ?? null,
    profile_id: request.profile_id ?? null,
    profile_mode: request.profile_mode ?? "ephemeral",
    proxy: request.proxy ? redactProxy(request.proxy) : null,
    launch: request.launch ?? {}
  };
}

function redactProxy(proxy: ProxyConfig): ProxyConfig {
  return {
    ...proxy,
    username: proxy.username ? "<redacted>" : null,
    password: proxy.password ? "<redacted>" : null
  };
}

function auditDetail(message: string): { message: string } {
  return { message };
}

function buildLiveViewUrl(baseUrl: string, password: string): string {
  return `${baseUrl}#password=${encodeURIComponent(password)}&view_only=true`;
}

function mouseButtonCode(button: string): string {
  switch (button) {
    case "middle":
      return "2";
    case "right":
      return "3";
    default:
      return "1";
  }
}

function sanitizeFileName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

async function createSessionLayout(artifactDir: string): Promise<void> {
  for (const path of [
    artifactDir,
    join(artifactDir, "downloads"),
    join(artifactDir, "uploads"),
    join(artifactDir, "captures"),
    join(artifactDir, "screenshots")
  ]) {
    await mkdir(path, { recursive: true });
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function ensureContainerWritable(path: string): Promise<void> {
  const details = await stat(path);
  await chmod(path, details.isDirectory() ? 0o777 : 0o666);
  if (!details.isDirectory()) {
    return;
  }
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    await ensureContainerWritable(join(path, entry.name));
  }
}
