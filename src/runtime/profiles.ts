import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import * as tar from "tar";

import type {
  ImportProfileRequest,
  ProfileExportResponse,
  ProfileImportResponse,
  ProfileMode,
  ProfileRecord
} from "../types.js";
import type { AppConfig } from "./config.js";
import type { SessionStore } from "./store.js";

export function validateProfileId(profileId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(profileId)) {
    throw new Error(`invalid profile id: ${profileId}`);
  }
}

export function namedProfileDir(config: AppConfig, profileId: string): string {
  validateProfileId(profileId);
  return join(config.dataDir, "profiles", profileId);
}

export function sessionProfileDir(config: AppConfig, sessionId: string): string {
  return join(config.dataDir, "sessions", sessionId, "profile");
}

export async function ensureSessionProfileDirectory(
  config: AppConfig,
  sessionId: string,
  profileId: string | null | undefined,
  profileMode: ProfileMode
): Promise<string> {
  if (profileId && (profileMode === "read_only" || profileMode === "read_write")) {
    const path = namedProfileDir(config, profileId);
    await mkdir(path, { recursive: true });
    return path;
  }

  const path = sessionProfileDir(config, sessionId);
  await mkdir(path, { recursive: true });
  if (profileId) {
    const source = namedProfileDir(config, profileId);
    await cp(source, path, { recursive: true, force: true });
  }
  return path;
}

export async function summarizeProfileDir(
  profileId: string,
  profileDir: string,
  store: SessionStore
): Promise<ProfileRecord> {
  const summary = await summarizeDirectory(profileDir);
  return {
    id: profileId,
    profile_dir: profileDir,
    file_count: summary.fileCount,
    total_bytes: summary.totalBytes,
    updated_at: summary.updatedAt,
    active_session_ids: store.listActiveSessionIdsByProfile(profileId)
  };
}

export async function listNamedProfileIds(config: AppConfig): Promise<string[]> {
  const base = join(config.dataDir, "profiles");
  const entries = await readdir(base, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

export async function importProfile(
  config: AppConfig,
  store: SessionStore,
  request: ImportProfileRequest
): Promise<ProfileImportResponse> {
  validateProfileId(request.profile_id);
  const destination = namedProfileDir(config, request.profile_id);
  const source = resolve(request.source_path);

  if (request.overwrite) {
    await rm(destination, { recursive: true, force: true });
  }
  await mkdir(destination, { recursive: true });

  if ((request.format ?? "tar_gz") === "directory") {
    await cp(source, destination, { recursive: true, force: true });
  } else {
    await tar.x({
      cwd: destination,
      file: source,
      gzip: true,
      strip: 0
    });
  }

  return {
    profile: await summarizeProfileDir(request.profile_id, destination, store),
    imported_from: source,
    format: request.format ?? "tar_gz"
  };
}

export async function exportProfile(
  config: AppConfig,
  store: SessionStore,
  profileId: string,
  request: { destination_path: string; format?: "tar_gz"; overwrite?: boolean }
): Promise<ProfileExportResponse> {
  validateProfileId(profileId);
  const source = namedProfileDir(config, profileId);
  const destination = resolve(request.destination_path);
  if (request.overwrite) {
    await rm(destination, { recursive: true, force: true });
  }
  await mkdir(dirnameOf(destination), { recursive: true });
  await tar.c(
    {
      cwd: source,
      file: destination,
      gzip: true
    },
    ["."]
  );

  return {
    profile: await summarizeProfileDir(profileId, source, store),
    destination_path: destination,
    format: request.format ?? "tar_gz"
  };
}

async function summarizeDirectory(path: string): Promise<{ fileCount: number; totalBytes: number; updatedAt: string | null }> {
  let fileCount = 0;
  let totalBytes = 0;
  let latestUpdatedAt: string | null = null;

  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory()) {
      const child = await summarizeDirectory(absolute);
      fileCount += child.fileCount;
      totalBytes += child.totalBytes;
      latestUpdatedAt = maxTimestamp(latestUpdatedAt, child.updatedAt);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const details = await stat(absolute);
    fileCount += 1;
    totalBytes += details.size;
    latestUpdatedAt = maxTimestamp(latestUpdatedAt, details.mtime.toISOString());
  }

  return { fileCount, totalBytes, updatedAt: latestUpdatedAt };
}

function dirnameOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/"))) || ".";
}

function maxTimestamp(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left > right ? left : right;
}
