// Finds or starts the apps/docs dev server of one checkout so previews can be captured from it.
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import path from "node:path";

export interface DocsServer {
  readonly url: string;
  readonly started: boolean;
  readonly log: string;
}

const stateFile = ".context/docs-dev.json";
const logFile = ".context/docs-dev.log";
const startTimeoutMs = 240_000;

/**
 * Returns a listening docs dev server for the checkout at `root`, starting `next dev` detached on a
 * free port when none is recorded. The server deliberately outlives the call so later captures
 * reuse it; its URL and pid live in `.context/docs-dev.json`. `VGPU_DOCS_URL` overrides discovery.
 *
 * Liveness is a TCP probe, not an HTTP request: the first request to a Next dev route compiles it
 * and can take far longer than a health-check timeout, which would start a duplicate server.
 *
 * @example
 *   const server = await ensureDocsServer("/repo");
 *   // server.url === "http://localhost:3017", server.started === false when it was already up
 */
export async function ensureDocsServer(root: string): Promise<DocsServer> {
  const log = path.join(root, logFile);
  const override = process.env.VGPU_DOCS_URL;
  if (override) {
    if (!(await listening(override))) throw new Error(`VGPU_DOCS_URL=${override} is not listening.`);
    return { url: override, started: false, log };
  }
  const recorded = await readRecordedState(root);
  if (recorded && (recorded.pid === null || processAlive(recorded.pid)) && (await listening(recorded.url))) {
    return { url: recorded.url, started: false, log };
  }
  return startServer(root, log);
}

/** Stops the detached docs server recorded for `root` and forgets its state. */
export async function stopDocsServer(root: string): Promise<void> {
  const recorded = await readRecordedState(root);
  if (typeof recorded?.pid === "number") {
    try {
      process.kill(-recorded.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await rm(path.join(root, stateFile), { force: true });
}

async function startServer(root: string, log: string): Promise<DocsServer> {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  await mkdir(path.join(root, ".context"), { recursive: true });
  const output = openSync(log, "w");
  const child = spawn("pnpm", ["--dir", "apps/docs", "dev", "--port", String(port)], {
    cwd: root,
    detached: true,
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  child.unref();
  await writeFile(
    path.join(root, stateFile),
    `${JSON.stringify({ url, pid: child.pid, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`docs dev server exited with code ${child.exitCode}; see ${log}`);
    if (await listening(url)) return { url, started: true, log };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`docs dev server did not listen within ${startTimeoutMs / 1000} s; see ${log}`);
}

async function readRecordedState(root: string): Promise<{ url: string; pid: number | null } | undefined> {
  const file = path.join(root, stateFile);
  if (!existsSync(file)) return undefined;
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as { url?: unknown; pid?: unknown };
    if (typeof state.url !== "string") return undefined;
    const pid = typeof state.pid === "number" && Number.isInteger(state.pid) && state.pid > 0 ? state.pid : null;
    return { url: state.url, pid };
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function listening(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname === "localhost" ? "127.0.0.1" : hostname, port: Number(port || 80) });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
