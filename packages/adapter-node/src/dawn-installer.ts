import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VGPUError } from "@vgpu/core";

export const dawnReleaseTag = "dawn-v0.4.0-vgpu.1";
export const dawnArtifactVersion = "0.4.0-vgpu.1";
export const dawnAssetName = "dawn-linux-arm64-gnu.node";
export const dawnAssetSha256 = "1d78020a40e1d5291c1bf8349155487ccbef7e123753fd4a5bbb3fe19a9e4277";
const publicAssetUrl = `https://github.com/vercel-labs/vgpu/releases/download/${dawnReleaseTag}/${dawnAssetName}`;
const githubReleasesApiUrl = "https://api.github.com/repos/vercel-labs/vgpu/releases?per_page=100";
const manualInstall = "Run `pnpm exec vgpu install-dawn` (or `npx @vgpu/cli install-dawn`) with network access, or set VGPU_DAWN_BINARY to a verified Dawn .node file.";
const defaultRequestTimeoutMs = 30_000;
const defaultOverallTimeoutMs = 65_000;

type Fetch = typeof globalThis.fetch;
export type DawnInstallOptions = {
  readonly fetch?: Fetch;
  readonly cacheRoot?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Test-only integrity override; production callers must use the pinned default. */
  readonly expectedSha256?: string;
  /** Test hook for libc taxonomy. */
  readonly libc?: "glibc" | "musl" | "unknown";
  readonly requestTimeoutMs?: number;
  readonly overallTimeoutMs?: number;
  readonly quiet?: boolean;
};

export type DawnInstallResult = { readonly path: string; readonly downloaded: boolean };
export type PrivateDawnCopy = { readonly path: string; readonly cleanup: () => void };

export function dawnCachePath(options: Pick<DawnInstallOptions, "cacheRoot"> = {}): string {
  const root = options.cacheRoot ?? process.env.VGPU_CACHE_DIR ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(root, "vgpu", "dawn", dawnArtifactVersion, "linux-arm64-gnu", dawnAssetName);
}

export function verifyDawnBinary(path: string, expectedSha256 = dawnAssetSha256): void {
  assertRegularNonSymlink(path);
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  assertHash(path, actual, expectedSha256);
}

export function getCachedDawnBinary(options: Pick<DawnInstallOptions, "cacheRoot" | "expectedSha256"> = {}): string | null {
  const path = dawnCachePath(options);
  if (!existsSync(path)) return null;
  verifyDawnBinary(path, options.expectedSha256);
  return path;
}

/**
 * Copies one opened source object into a private directory while hashing those
 * exact bytes. Native loading uses this copy, never the shared cache pathname.
 */
export function createPrivateDawnCopy(source: string, expectedSha256?: string): PrivateDawnCopy {
  assertRegularNonSymlink(source);
  const directory = mkdtempSync(join(tmpdir(), "vgpu-dawn-load-"));
  chmodSync(directory, 0o700);
  const destination = join(directory, basename(source));
  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    sourceFd = openSync(source, constants.O_RDONLY | noFollow);
    destinationFd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) offset += writeSync(destinationFd, buffer, offset, count - offset);
    }
    if (expectedSha256) assertHash(source, hash.digest("hex"), expectedSha256);
    closeSync(destinationFd);
    destinationFd = undefined;
    closeSync(sourceFd);
    sourceFd = undefined;
    return { path: destination, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (cause) {
    if (destinationFd !== undefined) closeSync(destinationFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
    rmSync(directory, { recursive: true, force: true });
    throw cause;
  }
}

export async function installDawn(options: DawnInstallOptions = {}): Promise<DawnInstallResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const unsupportedReason = getUnsupportedPrebuildReason({ ...options, platform, arch });
  if (unsupportedReason) throw prebuildMissing(unsupportedReason, undefined, platform, arch);

  const cached = getCachedDawnBinary(options);
  if (cached) return { path: cached, downloaded: false };

  const destination = dawnCachePath(options);
  try {
    assertCacheLocationWritable(dirname(destination));
  } catch (cause) {
    throw prebuildMissing(`cache directory is unavailable: ${String(cause)}`, cause, platform, arch);
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw prebuildMissing("blocked: this Node.js runtime does not provide fetch", undefined, platform, arch);

  const startedAt = Date.now();
  const overallTimeoutMs = options.overallTimeoutMs ?? defaultOverallTimeoutMs;
  const requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  const request = (url: string, init: RequestInit) =>
    fetchWithDeadline(fetchImpl, url, init, Math.min(requestTimeoutMs, remainingMs(startedAt, overallTimeoutMs)));
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  try {
    const download = token
      ? await resolveAuthenticatedAsset(request, token, () => remainingMs(startedAt, overallTimeoutMs))
      : { url: publicAssetUrl, headers: {} };
    const response = await request(download.url, { redirect: "follow", headers: download.headers });
    if (!response.ok || !response.body) throw httpError("GitHub release asset", response.status, response.statusText);

    const cacheDirectory = dirname(destination);
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    chmodSync(cacheDirectory, 0o700);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const stream = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      const bodyController = new AbortController();
      await withTimeout(
        pipeline(Readable.fromWeb(response.body as never), stream, { signal: bodyController.signal }),
        remainingMs(startedAt, overallTimeoutMs),
        "Dawn response body",
        () => bodyController.abort(),
      );
      verifyDawnBinary(temporary, options.expectedSha256);
      publishCacheFile(temporary, destination, options.expectedSha256);
    } finally {
      rmSync(temporary, { force: true });
    }
    return { path: destination, downloaded: true };
  } catch (cause) {
    if (cause instanceof VGPUError) throw cause;
    throw prebuildMissing(downloadFailureReason(cause), cause, platform, arch);
  }
}

export function getUnsupportedPrebuildReason(
  options: Pick<DawnInstallOptions, "platform" | "arch" | "libc"> = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "linux") return `unsupported platform ${platform}/${arch}; vgpu prebuilds currently target Linux arm64 only`;
  if (arch !== "arm64") return `unsupported platform ${platform}/${arch}; no vgpu prebuild is published for this CPU yet`;
  const libc = options.libc ?? detectLinuxLibc();
  if (libc === "musl") return "musl libc is unsupported; this prebuild requires glibc 2.31 or newer";
  if (libc !== "glibc") return "libc could not be identified as glibc; musl and unknown libc runtimes are unsupported";
  return null;
}

function publishCacheFile(temporary: string, destination: string, expectedSha256?: string): void {
  try {
    renameSync(temporary, destination);
  } catch (cause) {
    // Windows does not replace an existing destination. A concurrent verified
    // installer winning the race is success; anything else remains an error.
    if (!existsSync(destination)) throw cause;
    verifyDawnBinary(destination, expectedSha256);
  }
  chmodSync(destination, 0o600);
}

type Request = (url: string, init: RequestInit) => Promise<Response>;
async function resolveAuthenticatedAsset(
  request: Request,
  token: string,
  remaining: () => number,
): Promise<{ url: string; headers: Record<string, string> }> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "@vgpu/adapter-node" };
  const response = await request(githubReleasesApiUrl, { headers });
  if (!response.ok) throw httpError("GitHub releases API", response.status, response.statusText);
  const releases = (await withTimeout(response.json(), remaining(), "GitHub releases response body")) as {
    tag_name?: string;
    assets?: { name?: string; url?: string }[];
  }[];
  const release = releases.find((candidate) => candidate.tag_name === dawnReleaseTag);
  if (!release) throw new Error(`release ${dawnReleaseTag} was not found (HTTP 404 equivalent)`);
  const asset = release.assets?.find((candidate) => candidate.name === dawnAssetName);
  if (!asset?.url) throw new Error(`release ${dawnReleaseTag} does not contain asset ${dawnAssetName} (HTTP 404 equivalent)`);
  return { url: asset.url, headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream", "User-Agent": "@vgpu/adapter-node" } };
}

async function fetchWithDeadline(fetchImpl: Fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  return withTimeout(fetchImpl(url, { ...init, signal: controller.signal }), timeoutMs, `HTTP request to ${new URL(url).host}`, () => controller.abort());
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
    }, Math.max(1, timeoutMs));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

function remainingMs(startedAt: number, overallTimeoutMs: number): number {
  const remaining = overallTimeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) throw new Error(`Dawn download exceeded its ${overallTimeoutMs}ms overall deadline`);
  return remaining;
}

function assertCacheLocationWritable(cacheDirectory: string): void {
  let ancestor = cacheDirectory;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  try {
    const stats = lstatSync(ancestor);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("nearest existing ancestor is not a real directory");
    accessSync(ancestor, constants.W_OK);
  } catch (cause) {
    throw new Error(`cache directory ${cacheDirectory} is not writable: ${String(cause)}`);
  }
}

function detectLinuxLibc(): "glibc" | "musl" | "unknown" {
  if (existsSync("/etc/alpine-release")) return "musl";
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] } | undefined;
    if (report?.header?.glibcVersionRuntime) return "glibc";
    if (report?.sharedObjects?.some((path: string) => /(?:^|\/)ld-musl-|libc\.musl-/u.test(path))) return "musl";
  } catch {
    // Fail closed below: a GNU prebuild is never attempted without evidence.
  }
  return "unknown";
}

function assertRegularNonSymlink(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (cause) {
    throw checksumError(path, "the file cannot be inspected", cause);
  }
  if (stats.isSymbolicLink()) throw checksumError(path, "symbolic links are not accepted");
  if (!stats.isFile()) throw checksumError(path, "the path is not a regular file");
}

function assertHash(path: string, actual: string, expected: string): void {
  if (actual !== expected) throw checksumError(path, `SHA-256 ${actual} does not match pinned ${expected}`);
}

function checksumError(path: string, reason: string, cause?: unknown): VGPUError {
  return new VGPUError({
    code: "VGPU-NODE-PREBUILD-CHECKSUM",
    message: `Refusing Dawn prebuild ${path}: ${reason}.`,
    fix: `Delete the file and retry. ${manualInstall}`,
    where: "installDawn",
    cause,
  });
}

function httpError(scope: string, status: number, statusText: string): Error {
  if (status === 404) return new Error(`${scope} was not found (HTTP 404 ${statusText}); download failed or was blocked`);
  if (status >= 500) return new Error(`${scope} service unavailable (HTTP ${status} ${statusText})`);
  return new Error(`${scope} returned HTTP ${status} ${statusText}`);
}

function downloadFailureReason(cause: unknown): string {
  const text = String(cause);
  if (/timed out|deadline/iu.test(text)) return `download timed out or was blocked: ${text}`;
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|fetch failed|network|offline/iu.test(text)) return `offline: ${text}`;
  if (/HTTP 404|not found/iu.test(text)) return `download failed or was blocked: release or asset not found: ${text}`;
  if (/HTTP 5\d\d|service unavailable/iu.test(text)) return `GitHub service unavailable: ${text}`;
  if (/HTTP (?:401|403|407|429)|blocked/iu.test(text)) return `blocked by authentication, proxy, or rate limit: ${text}`;
  return `download failed or was blocked: ${text}`;
}

function prebuildMissing(reason: string, cause: unknown, platform: string, arch: string): VGPUError {
  return new VGPUError({
    code: "VGPU-NODE-PREBUILD-MISSING",
    message: `No portable Dawn prebuild is available for ${platform}/${arch}: ${reason}.`,
    fix: manualInstall,
    where: "installDawn",
    cause,
  });
}
