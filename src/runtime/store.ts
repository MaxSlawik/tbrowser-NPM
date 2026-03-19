import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import type {
  ApprovalAction,
  ApprovalRecord,
  ApprovalStatus,
  ArtifactKind,
  ArtifactRecord,
  AuditEventRecord,
  ProfileMode,
  ProxyConfig,
  SessionRecord,
  SessionStatus
} from "../types.js";

export interface PendingSessionInsert {
  id: string;
  label?: string | null;
  created_at: string;
  updated_at: string;
  last_browser_action_at?: string | null;
  expires_at?: string | null;
  initial_url?: string | null;
  ttl_seconds?: number | null;
  profile_id?: string | null;
  profile_mode: ProfileMode;
  proxy?: ProxyConfig | null;
  artifact_dir: string;
  profile_dir: string;
}

export interface RunningSessionUpdate {
  updated_at: string;
  last_browser_action_at: string;
  container_id: string;
  debug_port: number;
  vnc_port?: number | null;
  live_view_port?: number | null;
  cdp_http_url: string;
  live_view_url?: string | null;
}

export interface ApprovalInsert {
  id: string;
  session_id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  reason?: string | null;
  target_url?: string | null;
  requested_at: string;
  updated_at: string;
  expires_at?: string | null;
  reviewer?: string | null;
  note?: string | null;
}

export interface ArtifactInsert {
  id: string;
  session_id: string;
  kind: ArtifactKind;
  name: string;
  path: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  metadata: unknown;
}

export class SessionStore {
  readonly #db: Database.Database;

  public constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#db = new Database(databasePath);
    this.#db.pragma("foreign_keys = ON");
    this.migrate();
  }

  public insertPendingSession(session: PendingSessionInsert): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (
          id, label, status, created_at, updated_at, last_browser_action_at, expires_at,
          initial_url, ttl_seconds, profile_id, profile_mode, proxy_json, artifact_dir, profile_dir
        ) VALUES (
          @id, @label, @status, @created_at, @updated_at, @last_browser_action_at, @expires_at,
          @initial_url, @ttl_seconds, @profile_id, @profile_mode, @proxy_json, @artifact_dir, @profile_dir
        )`
      )
      .run({
        ...session,
        status: "creating" satisfies SessionStatus,
        proxy_json: session.proxy ? JSON.stringify(session.proxy) : null
      });
  }

  public markRunning(sessionId: string, update: RunningSessionUpdate): void {
    this.#db
      .prepare(
        `UPDATE sessions
         SET status = @status,
             updated_at = @updated_at,
             container_id = @container_id,
             debug_port = @debug_port,
             vnc_port = @vnc_port,
             live_view_port = @live_view_port,
             cdp_http_url = @cdp_http_url,
             live_view_url = @live_view_url,
             last_browser_action_at = @last_browser_action_at,
             last_error = NULL
         WHERE id = @session_id`
      )
      .run({
        ...update,
        status: "running" satisfies SessionStatus,
        session_id: sessionId
      });
  }

  public markFailed(sessionId: string, message: string): void {
    this.#db
      .prepare("UPDATE sessions SET status = ?, updated_at = ?, last_error = ? WHERE id = ?")
      .run("failed", nowString(), message, sessionId);
  }

  public markClosing(sessionId: string): void {
    this.#db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run("closing", nowString(), sessionId);
  }

  public markClosed(sessionId: string, lastError?: string | null): void {
    const now = nowString();
    this.#db
      .prepare(
        "UPDATE sessions SET status = ?, updated_at = ?, closed_at = ?, last_error = ? WHERE id = ?"
      )
      .run("closed", now, now, lastError ?? null, sessionId);
  }

  public touchBrowserActivity(sessionId: string): void {
    const now = nowString();
    this.#db
      .prepare("UPDATE sessions SET updated_at = ?, last_browser_action_at = ? WHERE id = ?")
      .run(now, now, sessionId);
  }

  public getSession(sessionId: string): SessionRecord | null {
    const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as SessionRow | undefined;
    return row ? parseSessionRow(row) : null;
  }

  public listSessions(): SessionRecord[] {
    const rows = this.#db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as SessionRow[];
    return rows.map(parseSessionRow);
  }

  public insertAuditEvent(sessionId: string, eventType: string, detail: unknown): AuditEventRecord {
    const createdAt = nowString();
    const result = this.#db
      .prepare(
        "INSERT INTO audit_events (session_id, created_at, event_type, detail_json) VALUES (?, ?, ?, ?)"
      )
      .run(sessionId, createdAt, eventType, JSON.stringify(detail));
    return {
      id: Number(result.lastInsertRowid),
      session_id: sessionId,
      created_at: createdAt,
      event_type: eventType,
      detail: detail as AuditEventRecord["detail"]
    };
  }

  public listAuditEvents(sessionId: string): AuditEventRecord[] {
    const rows = this.#db
      .prepare(
        "SELECT id, session_id, created_at, event_type, detail_json FROM audit_events WHERE session_id = ? ORDER BY id DESC"
      )
      .all(sessionId) as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      session_id: row.session_id,
      created_at: row.created_at,
      event_type: row.event_type,
      detail: JSON.parse(row.detail_json) as AuditEventRecord["detail"]
    }));
  }

  public insertApproval(approval: ApprovalInsert): ApprovalRecord {
    this.#db
      .prepare(
        `INSERT INTO approvals (
          id, session_id, action, status, reason, target_url,
          requested_at, updated_at, expires_at, reviewer, note
        ) VALUES (
          @id, @session_id, @action, @status, @reason, @target_url,
          @requested_at, @updated_at, @expires_at, @reviewer, @note
        )`
      )
      .run(approval);
    return this.getApprovalRequired(approval.id);
  }

  public updateApproval(id: string, patch: Partial<ApprovalInsert>): ApprovalRecord {
    const current = this.getApprovalRequired(id);
    const next = { ...current, ...patch };
    this.#db
      .prepare(
        `UPDATE approvals
         SET status = @status,
             updated_at = @updated_at,
             reviewer = @reviewer,
             note = @note,
             expires_at = @expires_at
         WHERE id = @id`
      )
      .run({
        id,
        status: next.status,
        updated_at: next.updated_at,
        reviewer: next.reviewer ?? null,
        note: next.note ?? null,
        expires_at: next.expires_at ?? null
      });
    return this.getApprovalRequired(id);
  }

  public getApproval(id: string): ApprovalRecord | null {
    const row = this.#db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row ? parseApprovalRow(row) : null;
  }

  public getApprovalRequired(id: string): ApprovalRecord {
    const approval = this.getApproval(id);
    if (!approval) {
      throw new Error(`approval not found: ${id}`);
    }
    return approval;
  }

  public listApprovals(sessionId: string): ApprovalRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM approvals WHERE session_id = ? ORDER BY requested_at DESC")
      .all(sessionId) as ApprovalRow[];
    return rows.map(parseApprovalRow);
  }

  public insertArtifact(artifact: ArtifactInsert): ArtifactRecord {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO artifacts (
          id, session_id, kind, name, path, content_type, size_bytes, created_at, metadata_json
        ) VALUES (
          @id, @session_id, @kind, @name, @path, @content_type, @size_bytes, @created_at, @metadata_json
        )`
      )
      .run({
        ...artifact,
        metadata_json: JSON.stringify(artifact.metadata)
      });
    return this.getArtifactRequired(artifact.session_id, artifact.id);
  }

  public getArtifact(sessionId: string, artifactId: string): ArtifactRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM artifacts WHERE session_id = ? AND id = ?")
      .get(sessionId, artifactId) as ArtifactRow | undefined;
    return row ? parseArtifactRow(row) : null;
  }

  public getArtifactRequired(sessionId: string, artifactId: string): ArtifactRecord {
    const artifact = this.getArtifact(sessionId, artifactId);
    if (!artifact) {
      throw new Error(`artifact not found: ${artifactId}`);
    }
    return artifact;
  }

  public findArtifactByPath(sessionId: string, path: string): ArtifactRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM artifacts WHERE session_id = ? AND path = ? LIMIT 1")
      .get(sessionId, path) as ArtifactRow | undefined;
    return row ? parseArtifactRow(row) : null;
  }

  public listArtifacts(sessionId: string): ArtifactRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at DESC")
      .all(sessionId) as ArtifactRow[];
    return rows.map(parseArtifactRow);
  }

  public listActiveSessionIdsByProfile(profileId: string): string[] {
    const rows = this.#db
      .prepare("SELECT id FROM sessions WHERE profile_id = ? AND status IN ('creating', 'running', 'closing')")
      .all(profileId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  public close(): void {
    this.#db.close();
  }

  private migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        label TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        closed_at TEXT,
        initial_url TEXT,
        ttl_seconds INTEGER,
        container_id TEXT,
        profile_id TEXT,
        profile_mode TEXT NOT NULL,
        proxy_json TEXT,
        artifact_dir TEXT NOT NULL,
        profile_dir TEXT NOT NULL,
        debug_port INTEGER,
        vnc_port INTEGER,
        live_view_port INTEGER,
        cdp_http_url TEXT,
        live_view_url TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_audit_events_session_id ON audit_events(session_id);
    `);
    try {
      this.#db.exec(`
        ALTER TABLE sessions ADD COLUMN last_browser_action_at TEXT;
      `);
    } catch {}
    this.#db.exec(`
      UPDATE sessions
      SET last_browser_action_at = updated_at
      WHERE last_browser_action_at IS NULL
        AND status IN ('creating', 'running', 'closing');
      CREATE INDEX IF NOT EXISTS idx_sessions_last_browser_action_at ON sessions(last_browser_action_at);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        target_url TEXT,
        requested_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        reviewer TEXT,
        note TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_session_path ON artifacts(session_id, path);
      CREATE INDEX IF NOT EXISTS idx_approvals_session_id ON approvals(session_id, requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id, created_at DESC);
    `);
  }
}

interface SessionRow {
  id: string;
  label: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_browser_action_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
  initial_url: string | null;
  ttl_seconds: number | null;
  container_id: string | null;
  profile_id: string | null;
  profile_mode: ProfileMode;
  proxy_json: string | null;
  artifact_dir: string;
  profile_dir: string;
  debug_port: number | null;
  vnc_port: number | null;
  live_view_port: number | null;
  cdp_http_url: string | null;
  live_view_url: string | null;
  last_error: string | null;
}

interface AuditRow {
  id: number;
  session_id: string;
  created_at: string;
  event_type: string;
  detail_json: string;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  reason: string | null;
  target_url: string | null;
  requested_at: string;
  updated_at: string;
  expires_at: string | null;
  reviewer: string | null;
  note: string | null;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  kind: ArtifactKind;
  name: string;
  path: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  metadata_json: string;
}

function parseSessionRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    label: row.label,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_browser_action_at: row.last_browser_action_at,
    expires_at: row.expires_at,
    closed_at: row.closed_at,
    initial_url: row.initial_url,
    ttl_seconds: row.ttl_seconds,
    container_id: row.container_id,
    profile_id: row.profile_id,
    profile_mode: row.profile_mode,
    proxy: row.proxy_json ? (JSON.parse(row.proxy_json) as ProxyConfig) : null,
    artifact_dir: row.artifact_dir,
    profile_dir: row.profile_dir,
    debug_port: row.debug_port,
    vnc_port: row.vnc_port,
    live_view_port: row.live_view_port,
    cdp_http_url: row.cdp_http_url,
    live_view_url: row.live_view_url,
    last_error: row.last_error
  };
}

function parseApprovalRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    action: row.action,
    status: row.status,
    reason: row.reason,
    target_url: row.target_url,
    requested_at: row.requested_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    reviewer: row.reviewer,
    note: row.note
  };
}

function parseArtifactRow(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    created_at: row.created_at,
    metadata: JSON.parse(row.metadata_json) as ArtifactRecord["metadata"]
  };
}

function nowString(): string {
  return new Date().toISOString();
}
