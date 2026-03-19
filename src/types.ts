export type SessionStatus = "creating" | "running" | "failed" | "closing" | "closed";

export type ProfileMode = "ephemeral" | "read_only" | "read_write";

export type ProxyKind = "http" | "https" | "socks5";

export interface ProxyConfig {
  kind: ProxyKind;
  host: string;
  port: number;
  username?: string | null;
  password?: string | null;
  bypass?: string[];
  label?: string | null;
}

export interface BrowserLaunchOptions {
  viewport_width?: number;
  viewport_height?: number;
  headless?: boolean;
  locale?: string | null;
}

export type ApprovalAction =
  | "desktop"
  | "navigate"
  | "upload"
  | "download"
  | "network_capture"
  | "trace_capture"
  | "tab_create"
  | "tab_close"
  | "sensitive_eval";

export interface PolicyRuleSet {
  blocked_hosts: string[];
  approval_hosts: string[];
  approval_actions: ApprovalAction[];
  sensitive_eval_keywords: string[];
}

export interface CreateSessionRequest {
  label?: string | null;
  initial_url?: string | null;
  ttl_seconds?: number | null;
  profile_id?: string | null;
  profile_mode?: ProfileMode;
  proxy?: ProxyConfig | null;
  launch?: BrowserLaunchOptions;
}

export type ProfileImportFormat = "directory" | "tar_gz";

export interface ImportProfileRequest {
  profile_id: string;
  source_path: string;
  format?: ProfileImportFormat;
  overwrite?: boolean;
}

export type ProfileExportFormat = "tar_gz";

export interface ExportProfileRequest {
  destination_path: string;
  format?: ProfileExportFormat;
  overwrite?: boolean;
}

export interface ProfileRecord {
  id: string;
  profile_dir: string;
  file_count: number;
  total_bytes: number;
  updated_at?: string | null;
  active_session_ids: string[];
}

export interface ProfileImportResponse {
  profile: ProfileRecord;
  imported_from: string;
  format: ProfileImportFormat;
}

export interface ProfileExportResponse {
  profile: ProfileRecord;
  destination_path: string;
  format: ProfileExportFormat;
}

export interface SessionRecord {
  id: string;
  label?: string | null;
  status: SessionStatus;
  created_at: string;
  updated_at: string;
  last_browser_action_at?: string | null;
  expires_at?: string | null;
  closed_at?: string | null;
  initial_url?: string | null;
  ttl_seconds?: number | null;
  container_id?: string | null;
  profile_id?: string | null;
  profile_mode: ProfileMode;
  proxy?: ProxyConfig | null;
  artifact_dir: string;
  profile_dir: string;
  debug_port?: number | null;
  vnc_port?: number | null;
  live_view_port?: number | null;
  cdp_http_url?: string | null;
  live_view_url?: string | null;
  last_error?: string | null;
}

export interface NavigateRequest {
  url: string;
  approval_id?: string | null;
}

export type MouseButton = "left" | "middle" | "right";

export interface DesktopMoveRequest {
  x: number;
  y: number;
  approval_id?: string | null;
}

export interface DesktopClickRequest {
  x: number;
  y: number;
  button?: MouseButton;
  clicks?: number;
  delay_ms?: number;
  approval_id?: string | null;
}

export interface DesktopDragRequest {
  start_x: number;
  start_y: number;
  end_x: number;
  end_y: number;
  button?: MouseButton;
  steps?: number;
  step_delay_ms?: number;
  hold_ms?: number;
  approval_id?: string | null;
}

export interface TypeTextRequest {
  text: string;
  delay_ms?: number;
  approval_id?: string | null;
}

export interface KeyPressRequest {
  key: string;
  approval_id?: string | null;
}

export interface ElementDragRequest {
  source_selector: string;
  target_selector: string;
  steps?: number;
  step_delay_ms?: number;
  hold_ms?: number;
  approval_id?: string | null;
}

export interface InputActionResponse {
  ok: boolean;
}

export interface ElementDragResponse extends InputActionResponse {
  source_x: number;
  source_y: number;
  target_x: number;
  target_y: number;
}

export interface EvalRequest {
  expression: string;
  await_promise?: boolean;
  return_by_value?: boolean;
  approval_id?: string | null;
}

export interface EvalResponse<TValue = JsonValue> {
  value: TValue;
}

export type ScreenshotFormat = "png" | "jpeg";

export interface ScreenshotRequest {
  format?: ScreenshotFormat;
  quality?: number | null;
  full_page?: boolean | null;
}

export interface PageSnapshot {
  url: string;
  title: string;
  html: string;
}

export interface LiveViewResponse {
  session_id: string;
  live_view_url?: string | null;
  cdp_http_url: string;
}

export type ArtifactKind =
  | "screenshot"
  | "upload"
  | "download"
  | "network_capture"
  | "trace"
  | "log";

export interface ArtifactRecord {
  id: string;
  session_id: string;
  kind: ArtifactKind;
  name: string;
  path: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  metadata: JsonValue;
}

export interface AuditEventRecord {
  id: number;
  session_id: string;
  created_at: string;
  event_type: string;
  detail: JsonValue;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequest {
  action: ApprovalAction;
  reason?: string | null;
  target_url?: string | null;
  ttl_seconds?: number | null;
}

export interface ApprovalDecisionRequest {
  approved: boolean;
  reviewer?: string | null;
  note?: string | null;
}

export interface ApprovalRecord {
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

export interface UploadFileRequest {
  selector: string;
  file_name: string;
  content_base64?: string | null;
  source_path?: string | null;
  mime_type?: string | null;
  approval_id?: string | null;
}

export interface UploadFileResponse {
  artifact: ArtifactRecord;
}

export interface WaitForDownloadRequest {
  timeout_ms?: number;
  settle_ms?: number;
  approval_id?: string | null;
}

export interface TabRecord {
  id: string;
  title: string;
  url: string;
  target_type: string;
}

export interface CreateTabRequest {
  url?: string | null;
  approval_id?: string | null;
}

export interface NetworkCaptureRequest {
  duration_ms?: number;
  approval_id?: string | null;
}

export interface TraceCaptureRequest {
  duration_ms?: number;
  categories?: string[];
  approval_id?: string | null;
}

export interface ServerEvent {
  id: number;
  kind: string;
  session_id?: string | null;
  created_at: string;
  payload: JsonValue;
}

export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface TbrowserClientOptions {
  baseUrl?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface UploadFromPathRequest {
  selector: string;
  path: string;
  fileName?: string;
  mimeType?: string | null;
  approvalId?: string | null;
}

export interface UploadTextRequest {
  selector: string;
  text: string;
  fileName: string;
  mimeType?: string | null;
  approvalId?: string | null;
}

export interface DownloadToPathResult {
  artifact: ArtifactRecord;
  destinationPath: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface BinaryResponse {
  data: Buffer;
  contentType: string | null;
  fileName: string | null;
}
