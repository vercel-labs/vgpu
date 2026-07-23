import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VGPUError } from "@vgpu/core";
import {
  getCachedSoftwareRenderer, softwareRendererCacheDirectory, softwareRendererError,
  softwareRendererExpectedHash, softwareRendererExpectedHashes, softwareRendererIcdPath,
  softwareRendererReleaseTag, softwareRendererVersion, verifySoftwareRendererArchive,
  verifySoftwareRendererFiles, type SoftwareRendererCacheOptions,
} from "./software-renderer-cache.ts";

export { getCachedSoftwareRenderer, softwareRendererCacheDirectory, softwareRendererIcdPath, softwareRendererReleaseTag, softwareRendererVersion } from "./software-renderer-cache.ts";
const expectedMembers = new Set(["libvulkan_lvp.so", "lvp_icd.json"]);
const defaultTimeoutMs = 65_000;
const defaultMaxBytes = 32 * 1024 * 1024;
export type SoftwareRendererInstallOptions = SoftwareRendererCacheOptions & {
  readonly fetch?: typeof globalThis.fetch;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
};
export type SoftwareRendererInstallResult = { readonly path: string; readonly downloaded: boolean };

export async function installSoftwareRenderer(options: SoftwareRendererInstallOptions = {}): Promise<SoftwareRendererInstallResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "linux" || !softwareRendererExpectedHashes[arch]) throw softwareRendererError("VGPU-NODE-SOFTWARE-RENDERER-UNSUPPORTED", `The portable software renderer is not available for ${platform}/${arch}; it currently supports Linux x64 and arm64.`);
  const destination = softwareRendererCacheDirectory({ ...options, arch });
  try {
    const cached = getCachedSoftwareRenderer({ ...options, arch });
    if (cached) return { path: cached, downloaded: false };
  } catch {
    // The explicit installer is also the supported repair path for a poisoned cache.
    rmSync(destination, { recursive: true, force: true });
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw softwareRendererError("VGPU-NODE-SOFTWARE-RENDERER-DOWNLOAD", "Software renderer download failed: this Node.js runtime does not provide fetch.");
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(temporary, { mode: 0o700 });
  const asset = `mesa-lavapipe-25.0.7-linux-${arch}.tar.gz`;
  const archive = join(temporary, asset);
  const url = `https://github.com/vercel-labs/vgpu/releases/download/${softwareRendererReleaseTag}/${asset}`;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const controller = new AbortController();
  try {
    const response = await withTimeout(fetchImpl(url, { redirect: "follow", signal: controller.signal }), timeoutMs, controller);
    if (!response.ok || !response.body) throw new Error(`GitHub release asset returned HTTP ${response.status} ${response.statusText}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`software renderer archive exceeds ${maxBytes} byte limit`);
    let bytes = 0;
    const limiter = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxBytes ? new Error(`software renderer archive exceeds ${maxBytes} byte limit`) : null, chunk);
    } });
    await withTimeout(pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(archive, { flags: "wx", mode: 0o600 }), { signal: controller.signal }), timeoutMs, controller);
    verifySoftwareRendererArchive(archive, options.expectedSha256 ?? softwareRendererExpectedHash(arch));
    const spawnOptions = { encoding: "utf8" as const, env: { PATH: "/usr/bin:/bin", LANG: "C" } };
    const listing = spawnSync("/usr/bin/tar", ["-tzf", archive], spawnOptions);
    if (listing.status !== 0) throw new Error(`tar could not inspect the archive: ${listing.stderr}`);
    const members = listing.stdout.trim().split(/\r?\n/u);
    if (members.length !== expectedMembers.size || members.some((member) => !expectedMembers.has(member))) throw new Error(`archive contains unexpected paths: ${members.join(", ")}`);
    const extraction = spawnSync("/usr/bin/tar", ["-xzf", archive, "-C", temporary, "--no-same-owner", "--no-same-permissions"], spawnOptions);
    if (extraction.status !== 0) throw new Error(`tar could not extract the archive: ${extraction.stderr}`);
    verifySoftwareRendererFiles(temporary, arch);
    chmodSync(join(temporary, "lvp_icd.json"), 0o600);
    chmodSync(join(temporary, "libvulkan_lvp.so"), 0o700);
    try { renameSync(temporary, destination); }
    catch (cause) { if (!getCachedSoftwareRenderer({ ...options, arch })) throw cause; }
    return { path: softwareRendererIcdPath({ ...options, arch }), downloaded: true };
  } catch (cause) {
    if (cause instanceof VGPUError) throw cause;
    throw softwareRendererError("VGPU-NODE-SOFTWARE-RENDERER-DOWNLOAD", `Software renderer download failed: ${String(cause)}`, cause);
  } finally { controller.abort(); rmSync(temporary, { recursive: true, force: true }); }
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { controller.abort(); reject(new Error(`software renderer download timed out after ${timeoutMs}ms`)); }, Math.max(1, timeoutMs));
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}
