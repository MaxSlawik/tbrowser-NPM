#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import process from "node:process";

import { TbrowserApiError, TbrowserClient } from "./client.js";
import { createTbrowserServer } from "./server.js";
import type { JsonValue } from "./types.js";

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.length === 0 || hasFlag(rawArgs, "--help") || hasFlag(rawArgs, "-h")) {
    printHelp();
    return;
  }

  if (rawArgs[0] === "serve") {
    await handleServe(rawArgs.slice(1));
    return;
  }

  const baseUrl = takeOption(rawArgs, "--base-url") ?? process.env.TBROWSER_BASE_URL ?? "http://127.0.0.1:3000";
  const pretty = !hasFlag(rawArgs, "--compact");
  const client = new TbrowserClient({ baseUrl });

  const [group, action, ...rest] = rawArgs;
  let result: unknown;

  switch (group) {
    case "health":
      result = { ok: await client.health() };
      break;
    case "policy":
      result = await client.getPolicy();
      break;
    case "request":
      result = await handleRawRequest(client, action ? [action, ...rest] : rest);
      break;
    case "sessions":
      result = await handleSessions(client, action, rest);
      break;
    case "profiles":
      result = await handleProfiles(client, action, rest);
      break;
    case "approvals":
      result = await handleApprovals(client, action, rest);
      break;
    case "artifacts":
      result = await handleArtifacts(client, action, rest);
      break;
    case "tabs":
      result = await handleTabs(client, action, rest);
      break;
    case "uploads":
      result = await handleUploads(client, action, rest);
      break;
    case "downloads":
      result = await handleDownloads(client, action, rest);
      break;
    case "captures":
      result = await handleCaptures(client, action, rest);
      break;
    case "desktop":
      result = await handleDesktop(client, action, rest);
      break;
    case "events":
      result = await handleEvents(client, action, rest, pretty);
      return;
    default:
      throw new Error(`unknown command group: ${group}`);
  }

  printJson(result, pretty);
}

async function handleServe(args: string[]): Promise<void> {
  const server = await createTbrowserServer(
    compactObject({
      bindAddr: nullToUndefined(takeOption(args, "--bind-addr")),
      dataDir: nullToUndefined(takeOption(args, "--data-dir")),
      browserImage: nullToUndefined(takeOption(args, "--browser-image")),
      publicHost: nullToUndefined(takeOption(args, "--public-host"))
    })
  );
  await server.listen();
  console.log(JSON.stringify({ bind_addr: server.config.bindAddr, data_dir: server.config.dataDir }, null, 2));
  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      void server.close().then(resolve).catch(reject);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function handleRawRequest(client: TbrowserClient, args: string[]): Promise<unknown> {
  const [method, path, ...rest] = args;
  if (!method || !path) {
    throw new Error("usage: tbrowser request <method> <path> [--json body] [--output path] [--binary]");
  }
  const output = takeOption(rest, "--output");
  const body = parseOptionalJson(takeOption(rest, "--json"));
  if (hasFlag(rest, "--binary")) {
    const binary = await client.requestBinary(method.toUpperCase(), path, body);
    if (output) {
      await writeFile(output, binary.data);
      return { output, content_type: binary.contentType, file_name: binary.fileName };
    }
    process.stdout.write(binary.data);
    return undefined;
  }
  return client.requestJson(method.toUpperCase(), path, body);
}

async function handleSessions(client: TbrowserClient, action: string | undefined, args: string[]): Promise<unknown> {
  switch (action) {
    case "list":
      return client.listSessions();
    case "get":
      return client.getSession(takePositional(args, 0, "session_id"));
    case "create":
      return client.createSession(parseRequiredObject(takeOption(args, "--json"), "--json"));
    case "close":
      return client.closeSession(takePositional(args, 0, "session_id"));
    case "live":
      return client.getLiveView(takePositional(args, 0, "session_id"));
    case "navigate":
      return client.navigate(takePositional(args, 0, "session_id"), {
        url: requiredOption(args, "--url"),
        approval_id: takeOption(args, "--approval-id")
      });
    case "eval":
      return client.evaluate(takePositional(args, 0, "session_id"), {
        expression: requiredOption(args, "--expression"),
        approval_id: takeOption(args, "--approval-id"),
        await_promise: !hasFlag(args, "--no-await-promise"),
        return_by_value: !hasFlag(args, "--no-return-by-value")
      });
    case "snapshot":
      return client.snapshot(takePositional(args, 0, "session_id"));
    case "screenshot": {
      const sessionId = takePositional(args, 0, "session_id");
      const output = requiredOption(args, "--output");
      const format = takeOption(args, "--format") as "png" | "jpeg" | null;
      const quality = takeOption(args, "--quality");
      await client.saveScreenshot(
        sessionId,
        output,
        compactObject({
          format: format ?? undefined,
          quality: quality ? Number(quality) : undefined,
          full_page: hasFlag(args, "--full-page") ? true : undefined
        })
      );
      return { output };
    }
    default:
      throw new Error("usage: tbrowser sessions <list|get|create|close|live|navigate|eval|snapshot|screenshot> ...");
  }
}

async function handleProfiles(client: TbrowserClient, action: string | undefined, args: string[]): Promise<unknown> {
  switch (action) {
    case "list":
      return client.listProfiles();
    case "get":
      return client.getProfile(takePositional(args, 0, "profile_id"));
    case "import":
      return client.importProfile(parseRequiredObject(takeOption(args, "--json"), "--json"));
    case "export":
      return client.exportProfile(takePositional(args, 0, "profile_id"), parseRequiredObject(takeOption(args, "--json"), "--json"));
    default:
      throw new Error("usage: tbrowser profiles <list|get|import|export> ...");
  }
}

async function handleApprovals(client: TbrowserClient, action: string | undefined, args: string[]): Promise<unknown> {
  switch (action) {
    case "list":
      return client.listApprovals(takePositional(args, 0, "session_id"));
    case "create":
      return client.createApproval(takePositional(args, 0, "session_id"), parseRequiredObject(takeOption(args, "--json"), "--json"));
    case "decide":
      return client.decideApproval(takePositional(args, 0, "approval_id"), parseRequiredObject(takeOption(args, "--json"), "--json"));
    default:
      throw new Error("usage: tbrowser approvals <list|create|decide> ...");
  }
}

async function handleArtifacts(client: TbrowserClient, action: string | undefined, args: string[]): Promise<unknown> {
  switch (action) {
    case "list":
      return client.listArtifacts(takePositional(args, 0, "session_id"));
    case "get": {
      const sessionId = takePositional(args, 0, "session_id");
      const artifactId = takePositional(args, 1, "artifact_id");
      const output = requiredOption(args, "--output");
      await client.downloadArtifactToPath(sessionId, artifactId, output);
      return { output };
    }
    default:
      throw new Error("usage: tbrowser artifacts <list|get> ...");
  }
}

async function handleTabs(client: TbrowserClient, action: string | undefined, args: string[]): Promise<unknown> {
  switch (action) {
    case "list":
      return client.listTabs(takePositional(args, 0, "session_id"));
    case "create":
      return client.createTab(takePositional(args, 0, "session_id"), parseOptionalObject(takeOption(args, "--json")) ?? {});
    case "activate":
      await client.activateTab(takePositional(args, 0, "session_id"), takePositional(args, 1, "tab_id"));
      return { ok: true };
    case "close":
      await client.closeTab(
        takePositional(args, 0, "session_id"),
        takePositional(args, 1, "tab_id"),
        takeOption(args, "--approval-id")
      );
      return { ok: true };
    default:
      throw new Error("usage: tbrowser tabs <list|create|activate|close> ...");
  }
}

async function handleUploads(client: TbrowserClient, action: string | undefined, args: string[]): Promise<unknown> {
  switch (action) {
    case "raw":
      return client.uploadFile(takePositional(args, 0, "session_id"), parseRequiredObject(takeOption(args, "--json"), "--json"));
    case "from-path":
      return client.uploadFileFromPath(takePositional(args, 0, "session_id"), {
        selector: requiredOption(args, "--selector"),
        path: requiredOption(args, "--path"),
        ...compactObject({
          fileName: nullToUndefined(takeOption(args, "--file-name")),
          mimeType: nullToUndefined(takeOption(args, "--mime-type")),
          approvalId: nullToUndefined(takeOption(args, "--approval-id"))
        })
      });
    case "from-text":
      return client.uploadText(takePositional(args, 0, "session_id"), {
        selector: requiredOption(args, "--selector"),
        text: requiredOption(args, "--text"),
        fileName: requiredOption(args, "--file-name"),
        ...compactObject({
          mimeType: nullToUndefined(takeOption(args, "--mime-type")),
          approvalId: nullToUndefined(takeOption(args, "--approval-id"))
        })
      });
    default:
      throw new Error("usage: tbrowser uploads <raw|from-path|from-text> ...");
  }
}

async function handleDownloads(client: TbrowserClient, action: string | undefined, args: string[]): Promise<unknown> {
  switch (action) {
    case "wait":
      return client.waitForDownload(takePositional(args, 0, "session_id"), parseOptionalObject(takeOption(args, "--json")) ?? {});
    case "wait-save":
      return client.waitForDownloadToPath(
        takePositional(args, 0, "session_id"),
        requiredOption(args, "--dir"),
        parseOptionalObject(takeOption(args, "--json")) ?? {}
      );
    default:
      throw new Error("usage: tbrowser downloads <wait|wait-save> ...");
  }
}

async function handleCaptures(client: TbrowserClient, action: string | undefined, args: string[]): Promise<unknown> {
  switch (action) {
    case "network":
      return client.captureNetwork(takePositional(args, 0, "session_id"), parseOptionalObject(takeOption(args, "--json")) ?? {});
    case "trace":
      return client.captureTrace(takePositional(args, 0, "session_id"), parseOptionalObject(takeOption(args, "--json")) ?? {});
    default:
      throw new Error("usage: tbrowser captures <network|trace> ...");
  }
}

async function handleDesktop(client: TbrowserClient, action: string | undefined, args: string[]): Promise<unknown> {
  const sessionId = takePositional(args, 0, "session_id");
  switch (action) {
    case "move":
      return client.moveMouse(sessionId, parseRequiredObject(takeOption(args, "--json"), "--json"));
    case "click":
      return client.clickMouse(sessionId, parseRequiredObject(takeOption(args, "--json"), "--json"));
    case "drag":
      return client.dragMouse(sessionId, parseRequiredObject(takeOption(args, "--json"), "--json"));
    case "type":
      return client.typeText(sessionId, parseRequiredObject(takeOption(args, "--json"), "--json"));
    case "key":
      return client.pressKey(sessionId, parseRequiredObject(takeOption(args, "--json"), "--json"));
    case "drag-element":
      return client.dragElement(sessionId, parseRequiredObject(takeOption(args, "--json"), "--json"));
    default:
      throw new Error("usage: tbrowser desktop <move|click|drag|type|key|drag-element> <session_id> --json '{...}'");
  }
}

async function handleEvents(
  client: TbrowserClient,
  action: string | undefined,
  args: string[],
  pretty: boolean
): Promise<void> {
  switch (action) {
    case "list":
      printJson(await client.listEvents(takePositional(args, 0, "session_id")), pretty);
      return;
    case "stream": {
      const stream = client.subscribeSessionEvents(takePositional(args, 0, "session_id"));
      await stream.waitUntilOpen();
      stream.on("event", (event) => {
        printJson(event, pretty);
      });
      stream.on("error", (error) => {
        console.error(formatError(error));
        process.exitCode = 1;
      });
      await new Promise<void>((resolve) => {
        stream.on("close", () => resolve());
        process.on("SIGINT", () => {
          stream.close(1000, "interrupt");
        });
      });
      return;
    }
    default:
      throw new Error("usage: tbrowser events <list|stream> ...");
  }
}

function takePositional(args: string[], index: number, name: string): string {
  const positional = args.filter((value, position) => {
    if (value.startsWith("--")) {
      return false;
    }
    if (position > 0 && args[position - 1]?.startsWith("--")) {
      return false;
    }
    return true;
  });
  const value = positional[index];
  if (!value) {
    throw new Error(`missing required argument: ${name}`);
  }
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  const index = args.indexOf(flag);
  if (index >= 0) {
    args.splice(index, 1);
    return true;
  }
  return false;
}

function takeOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for option: ${name}`);
  }
  args.splice(index, 2);
  return value;
}

function requiredOption(args: string[], name: string): string {
  const value = takeOption(args, name);
  if (value === null) {
    throw new Error(`missing required option: ${name}`);
  }
  return value;
}

function parseOptionalJson(value: string | null): JsonValue | Record<string, unknown> | undefined {
  if (value === null) {
    return undefined;
  }
  return JSON.parse(value) as JsonValue | Record<string, unknown>;
}

function parseOptionalObject<T extends object>(value: string | null): T | undefined {
  if (value === null) {
    return undefined;
  }
  return parseRequiredObject<T>(value, "--json");
}

function parseRequiredObject<T extends object>(value: string | null, name: string): T {
  if (value === null) {
    throw new Error(`missing required option: ${name}`);
  }
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return parsed as T;
}

function printJson(value: unknown, pretty: boolean): void {
  if (value === undefined) {
    return;
  }
  const spaces = pretty ? 2 : 0;
  console.log(JSON.stringify(value, null, spaces));
}

function formatError(error: unknown): string {
  if (error instanceof TbrowserApiError) {
    return `${error.name}: ${error.message} (${error.status} ${error.statusText})`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function printHelp(): void {
  console.log(`tbrowser Node client and CLI

Usage:
  tbrowser [--base-url URL] <command>
  tbrowser serve [--bind-addr HOST:PORT] [--data-dir PATH]

Core commands:
  tbrowser health
  tbrowser policy
  tbrowser request <method> <path> [--json BODY] [--binary] [--output PATH]

Session commands:
  tbrowser sessions list
  tbrowser sessions get <session_id>
  tbrowser sessions create --json '{"label":"demo","launch":{"headless":true}}'
  tbrowser sessions close <session_id>
  tbrowser sessions live <session_id>
  tbrowser sessions navigate <session_id> --url https://example.com [--approval-id ID]
  tbrowser sessions eval <session_id> --expression 'document.title'
  tbrowser sessions snapshot <session_id>
  tbrowser sessions screenshot <session_id> --output page.png [--format png|jpeg]

Other groups:
  profiles, approvals, artifacts, tabs, uploads, downloads, captures, desktop, events

Examples:
  tbrowser serve --bind-addr 127.0.0.1:3000
  tbrowser sessions create --json '{"label":"demo","initial_url":"https://example.com","launch":{"headless":true}}'
  tbrowser uploads from-path <session_id> --selector '#upload' --path ./invoice.pdf
  tbrowser events stream <session_id>
`);
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function nullToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

main().catch((error) => {
  console.error(formatError(error));
  process.exit(1);
});
