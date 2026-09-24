// Launches a throwaway headless Chrome with WebGPU enabled and speaks raw CDP to its first page.
// Raw CDP keeps the preview tooling dependency-free: no Playwright install, no browser download.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import path from "node:path";

export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface ChromePage {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  onEvent(listener: (event: CdpEvent) => void): void;
  close(): Promise<void>;
}

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Starts headless Chrome (`VGPU_CHROME_PATH`, else the installed Google Chrome) with
 * `--enable-unsafe-webgpu` and returns a CDP handle for its page. On macOS the adapter is the real
 * Metal GPU; on Linux it selects SwiftShader like docs/topics/agent-browser-webgpu.docs.md.
 * Background throttling is disabled so requestAnimationFrame keeps its display rate headless.
 *
 * @example
 *   const page = await launchChrome({ width: 1280, height: 720 });
 *   await page.send("Page.navigate", { url: "http://localhost:3017/preview/gradient" });
 *   await page.close();
 */
export async function launchChrome(viewport: { width: number; height: number }): Promise<ChromePage> {
  const executable = chromePath();
  const profile = await mkdtemp(path.join(tmpdir(), "vgpu-preview-"));
  const linuxWebgpu = platform() === "linux"
    ? ["--enable-features=Vulkan", "--use-angle=vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--disable-vulkan-surface"]
    : [];
  const browser = spawn(executable, [
    "--headless",
    "--enable-unsafe-webgpu",
    ...linuxWebgpu,
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${viewport.width},${viewport.height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const shutdown = async () => {
    browser.kill("SIGKILL");
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const endpoint = await devtoolsEndpoint(browser.stderr);
    const targets = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((candidate) => candidate.type === "page");
    if (!target) throw new Error("Chrome started without a page target.");
    return await connectPage(target.webSocketDebuggerUrl, shutdown);
  } catch (error) {
    await shutdown();
    throw error;
  }
}

function chromePath(): string {
  const configured = process.env.VGPU_CHROME_PATH;
  if (configured) return configured;
  if (platform() === "darwin" && existsSync(macChrome)) return macChrome;
  for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("No Chrome executable found; set VGPU_CHROME_PATH.");
}

function devtoolsEndpoint(stderr: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not expose DevTools within 20 s:\n${output.slice(-2000)}`)), 20_000);
    stderr.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
  });
}

async function connectPage(url: string, shutdown: () => Promise<void>): Promise<ChromePage> {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open.")), { once: true });
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const listeners: Array<(event: CdpEvent) => void> = [];
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown> };
    if (data.id !== undefined) {
      const request = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) request?.reject(new Error(data.error.message));
      else request?.resolve(data.result ?? {});
      return;
    }
    if (data.method) for (const listener of listeners) listener({ method: data.method, params: data.params ?? {} });
  });
  return {
    send(method, params = {}, timeoutMs = 60_000) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    onEvent(listener) {
      listeners.push(listener);
    },
    async close() {
      socket.close();
      await shutdown();
    },
  };
}
