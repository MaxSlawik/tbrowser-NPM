import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import Docker from "dockerode";

import type { BrowserLaunchOptions, ProxyConfig } from "../types.js";

const DEBUG_PORT = "9222/tcp";
const LIVE_VIEW_PORT = "6080/tcp";
const VNC_PORT = "5900/tcp";

export interface RunnerConfig {
  image: string;
  publicHost: string;
}

export interface LaunchSessionRequest {
  sessionId: string;
  initialUrl?: string | null;
  profileDir: string;
  profileReadOnly: boolean;
  artifactDir: string;
  proxy?: ProxyConfig | null;
  proxyAuthFile?: string | null;
  liveViewPasswordFile?: string | null;
  launch: BrowserLaunchOptions;
}

export interface LaunchedSession {
  containerId: string;
  debugPort: number;
  liveViewPort?: number | null;
  vncPort?: number | null;
  cdpHttpUrl: string;
  liveViewUrl?: string | null;
}

export class DockerRunner {
  readonly #docker: Docker;
  readonly #config: RunnerConfig;

  public constructor(config: RunnerConfig) {
    this.#docker = connectDocker();
    this.#config = config;
  }

  public async launchSession(request: LaunchSessionRequest): Promise<LaunchedSession> {
    const containerName = `tbrowser-${request.sessionId}`;
    const container = await this.#docker.createContainer({
      name: containerName,
      Image: this.#config.image,
      Env: buildEnv(request),
      ExposedPorts: exposedPorts(Boolean(request.launch.headless)),
      Labels: {
        "tbrowser.managed": "true",
        "tbrowser.session": request.sessionId
      },
      HostConfig: {
        AutoRemove: false,
        Binds: [
          bindMount(request.profileDir, "/data/profile", request.profileReadOnly),
          bindMount(request.artifactDir, "/data/artifacts", false)
        ],
        PortBindings: portBindings(Boolean(request.launch.headless))
      }
    });
    await container.start();
    const launched = await this.inspectLaunchedSession(container.id, Boolean(request.launch.headless));
    await this.waitForCdp(launched.cdpHttpUrl, 25_000);
    return launched;
  }

  public async destroySession(containerId: string): Promise<void> {
    try {
      const container = this.#docker.getContainer(containerId);
      await container.remove({ force: true });
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  public async prepareHostCleanup(containerId: string, paths: string[]): Promise<void> {
    if (paths.length === 0) {
      return;
    }
    const joined = paths.map(shellQuote).join(" ");
    await this.execCommand(containerId, [
      "sh",
      "-lc",
      `chmod -R u+rwX,go+rwX ${joined} || true`
    ]);
  }

  public async containerIsRunning(containerId: string): Promise<boolean> {
    try {
      const data = await this.#docker.getContainer(containerId).inspect();
      return Boolean(data.State?.Running);
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  public async moveMouse(containerId: string, x: number, y: number): Promise<void> {
    await this.execScript(containerId, `${focusBrowserScript()}\nxdotool mousemove --sync ${x} ${y}`);
  }

  public async clickMouse(
    containerId: string,
    x: number,
    y: number,
    button: string,
    clicks: number,
    delayMs: number
  ): Promise<void> {
    await this.execScript(
      containerId,
      `${focusBrowserScript()}\nxdotool mousemove --sync ${x} ${y}\nxdotool click --repeat ${Math.max(clicks, 1)} --delay ${delayMs} ${button}`
    );
  }

  public async dragMouse(
    containerId: string,
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    button: string,
    steps: number,
    stepDelayMs: number,
    holdMs: number
  ): Promise<void> {
    const safeSteps = Math.max(steps, 2);
    await this.execScript(
      containerId,
      `${focusBrowserScript()}
START_X=${startX}
START_Y=${startY}
END_X=${endX}
END_Y=${endY}
STEPS=${safeSteps}
STEP_DELAY_MS=${stepDelayMs}
HOLD_MS=${holdMs}
BUTTON=${button}
xdotool mousemove --sync "$START_X" "$START_Y"
xdotool mousedown "$BUTTON"
sleep "$(awk "BEGIN { printf \\"%.3f\\", $HOLD_MS / 1000 }")"
i=1
while [ "$i" -le "$STEPS" ]; do
  CURRENT_X=$((START_X + (END_X - START_X) * i / STEPS))
  CURRENT_Y=$((START_Y + (END_Y - START_Y) * i / STEPS))
  xdotool mousemove "$CURRENT_X" "$CURRENT_Y"
  sleep "$(awk "BEGIN { printf \\"%.3f\\", $STEP_DELAY_MS / 1000 }")"
  i=$((i + 1))
done
xdotool mouseup "$BUTTON"`
    );
  }

  public async typeText(containerId: string, text: string, delayMs: number): Promise<void> {
    await this.execCommand(containerId, [
      "env",
      "DISPLAY=:99",
      "sh",
      "-lc",
      `${focusBrowserScript()}\nxdotool type --delay ${delayMs} --clearmodifiers -- ${shellQuote(text)}`
    ]);
  }

  public async pressKey(containerId: string, key: string): Promise<void> {
    await this.execScript(containerId, `${focusBrowserScript()}\nxdotool key --clearmodifiers ${shellQuote(key)}`);
  }

  public async inspectLaunchedSession(containerId: string, headless: boolean): Promise<LaunchedSession> {
    const details = await this.#docker.getContainer(containerId).inspect();
    const ports = details.NetworkSettings?.Ports ?? {};
    const debugPort = publishedPort(ports, DEBUG_PORT);
    const liveViewPort = headless ? null : publishedPortOptional(ports, LIVE_VIEW_PORT);
    const vncPort = headless ? null : publishedPortOptional(ports, VNC_PORT);
    const cdpHttpUrl = `http://${this.#config.publicHost}:${debugPort}`;
    return {
      containerId,
      debugPort,
      liveViewPort,
      vncPort,
      cdpHttpUrl,
      liveViewUrl: liveViewPort
        ? `http://${this.#config.publicHost}:${liveViewPort}/tbrowser.html?scale=true&quality=6&compression=2`
        : null
    };
  }

  private async waitForCdp(cdpHttpUrl: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = "unknown error";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${cdpHttpUrl.replace(/\/+$/, "")}/json/version`);
        if (response.ok) {
          return;
        }
        lastError = `unexpected CDP status ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await sleep(400);
    }
    throw new Error(`browser did not expose CDP before timeout: ${lastError}`);
  }

  private async execScript(containerId: string, script: string): Promise<void> {
    await this.execCommand(containerId, ["env", "DISPLAY=:99", "sh", "-lc", script]);
  }

  private async execCommand(containerId: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", ["exec", containerId, ...args], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `docker exec failed for ${containerId}: ${
              Buffer.concat(stderr).toString("utf8").trim() || "unknown error"
            }${
              stdout.length > 0 ? ` (stdout: ${Buffer.concat(stdout).toString("utf8").trim()})` : ""
            }`
          )
        );
      });
    });
  }
}

function connectDocker(): Docker {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    if (dockerHost.startsWith("unix://")) {
      return new Docker({ socketPath: dockerHost.slice("unix://".length) });
    }
    const url = new URL(dockerHost);
    return new Docker({
      host: url.hostname,
      port: Number.parseInt(url.port || (url.protocol === "https:" ? "2376" : "2375"), 10),
      protocol: url.protocol.replace(":", "") as "http" | "https"
    });
  }

  for (const socketPath of [
    process.env.DOCKER_SOCKET_PATH,
    join(homedir(), ".docker/run/docker.sock"),
    join(homedir(), ".colima/default/docker.sock"),
    join(homedir(), ".colima/docker.sock"),
    "/var/run/docker.sock"
  ]) {
    if (socketPath && existsSync(socketPath)) {
      return new Docker({ socketPath });
    }
  }

  return new Docker();
}

function buildEnv(request: LaunchSessionRequest): string[] {
  const env = [
    `SESSION_ID=${request.sessionId}`,
    `VIEWPORT_WIDTH=${request.launch.viewport_width ?? 1440}`,
    `VIEWPORT_HEIGHT=${request.launch.viewport_height ?? 960}`,
    `HEADLESS=${Boolean(request.launch.headless)}`
  ];
  if (request.launch.locale) {
    env.push(`BROWSER_LOCALE=${request.launch.locale}`);
  }
  if (request.initialUrl) {
    env.push(`INITIAL_URL=${request.initialUrl}`);
  }
  if (request.proxy) {
    env.push(`PROXY_URL=${chromeProxyUrl(request.proxy)}`);
    if (request.proxy.bypass && request.proxy.bypass.length > 0) {
      env.push(`PROXY_BYPASS=${request.proxy.bypass.join(",")}`);
    }
  }
  if (request.proxyAuthFile) {
    env.push(`PROXY_AUTH_FILE=${request.proxyAuthFile}`);
  }
  if (request.liveViewPasswordFile) {
    env.push(`LIVE_VIEW_PASSWORD_FILE=${request.liveViewPasswordFile}`);
  }
  return env;
}

function bindMount(source: string, target: string, readOnly: boolean): string {
  return `${source}:${target}${readOnly ? ":ro" : ""}`;
}

function exposedPorts(headless: boolean): Record<string, Record<string, never>> {
  const ports: Record<string, Record<string, never>> = {
    [DEBUG_PORT]: {}
  };
  if (!headless) {
    ports[LIVE_VIEW_PORT] = {};
    ports[VNC_PORT] = {};
  }
  return ports;
}

function portBindings(headless: boolean): Record<string, Array<{ HostIp: string; HostPort: string }>> {
  const bindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {
    [DEBUG_PORT]: [{ HostIp: "127.0.0.1", HostPort: "" }]
  };
  if (!headless) {
    bindings[LIVE_VIEW_PORT] = [{ HostIp: "127.0.0.1", HostPort: "" }];
    bindings[VNC_PORT] = [{ HostIp: "127.0.0.1", HostPort: "" }];
  }
  return bindings;
}

function publishedPort(
  ports: Record<string, Array<{ HostPort?: string | undefined }> | null>,
  name: string
): number {
  const value = publishedPortOptional(ports, name);
  if (!value) {
    throw new Error(`container missing published port data for ${name}`);
  }
  return value;
}

function publishedPortOptional(
  ports: Record<string, Array<{ HostPort?: string | undefined }> | null>,
  name: string
): number | null {
  const binding = ports[name]?.[0]?.HostPort;
  if (!binding) {
    return null;
  }
  return Number.parseInt(binding, 10);
}

function focusBrowserScript(): string {
  return "wmctrl -a Chromium || xdotool search --sync --name Chromium windowactivate || true";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function chromeProxyUrl(proxy: ProxyConfig): string {
  return `${proxy.kind}://${proxy.host}:${proxy.port}`;
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "statusCode" in error &&
      Number((error as { statusCode?: number }).statusCode) === 404
  );
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
