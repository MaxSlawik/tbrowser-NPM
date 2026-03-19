import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ApprovalAction, PolicyRuleSet } from "../types.js";

export interface AppConfig {
  bindAddr: string;
  cleanupIntervalSeconds: number;
  idleTimeoutSeconds: number;
  approvalTtlSeconds: number;
  dataDir: string;
  databasePath: string;
  browserImage: string;
  publicHost: string;
  policy: PolicyRuleSet;
}

export async function loadConfigFromEnv(overrides: Partial<AppConfig> = {}): Promise<AppConfig> {
  const dataDir = resolve(overrides.dataDir ?? process.env.TBROWSER_DATA_DIR ?? "./storage");
  const bindAddr = overrides.bindAddr ?? process.env.TBROWSER_BIND_ADDR ?? "127.0.0.1:3000";
  const cleanupIntervalSeconds = parseInteger(
    overrides.cleanupIntervalSeconds,
    process.env.TBROWSER_CLEANUP_INTERVAL_SECONDS,
    30
  );
  const idleTimeoutSeconds = parseInteger(
    overrides.idleTimeoutSeconds,
    process.env.TBROWSER_IDLE_TIMEOUT_SECONDS,
    300
  );
  const approvalTtlSeconds = parseInteger(
    overrides.approvalTtlSeconds,
    process.env.TBROWSER_APPROVAL_TTL_SECONDS,
    600
  );
  const browserImage = overrides.browserImage ?? process.env.TBROWSER_BROWSER_IMAGE ?? "tbrowser/browser-base:local";
  const publicHost = overrides.publicHost ?? process.env.TBROWSER_PUBLIC_HOST ?? "127.0.0.1";
  const databasePath = resolve(
    overrides.databasePath ?? normalizeDatabasePath(process.env.TBROWSER_DATABASE_URL) ?? `${dataDir}/state/tbrowser.db`
  );
  const policy = overrides.policy ?? (await loadPolicyFromEnv());

  return {
    bindAddr,
    cleanupIntervalSeconds,
    idleTimeoutSeconds,
    approvalTtlSeconds,
    dataDir,
    databasePath,
    browserImage,
    publicHost,
    policy
  };
}

export async function ensureLayout(config: AppConfig): Promise<void> {
  for (const path of [
    `${config.dataDir}/artifacts`,
    `${config.dataDir}/profiles`,
    `${config.dataDir}/sessions`,
    `${config.dataDir}/state`
  ]) {
    await mkdir(path, { recursive: true });
  }
}

async function loadPolicyFromEnv(): Promise<PolicyRuleSet> {
  const policyPath = process.env.TBROWSER_POLICY_PATH;
  if (!policyPath) {
    return defaultPolicy();
  }

  const raw = await readFile(policyPath, "utf8");
  return JSON.parse(raw) as PolicyRuleSet;
}

function defaultPolicy(): PolicyRuleSet {
  return {
    blocked_hosts: [],
    approval_hosts: [],
    approval_actions: ["desktop", "upload", "download"] satisfies ApprovalAction[],
    sensitive_eval_keywords: ["document.cookie", "navigator.clipboard", "localStorage", "sessionStorage"]
  };
}

function normalizeDatabasePath(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  return raw.startsWith("sqlite:") ? raw.slice("sqlite:".length) : raw;
}

function parseInteger(overrideValue: number | undefined, envValue: string | undefined, fallback: number): number {
  if (overrideValue !== undefined) {
    return overrideValue;
  }
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}
