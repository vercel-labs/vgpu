import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VGPUError } from "@vgpu/core";
import {
  assertSoftwareRendererRegularFile,
  getCachedSoftwareRenderer,
  softwareRendererCacheDirectory,
  softwareRendererError,
  softwareRendererExpectedHash,
  softwareRendererExpectedHashes,
  softwareRendererIcdPath,
  softwareRendererReleaseTag,
  softwareRendererVersion,
  verifySoftwareRendererArchive,
  type SoftwareRendererCacheOptions,
} from "./software-renderer-cache.ts";

export { getCachedSoftwareRenderer, softwareRendererCacheDirectory, softwareRendererIcdPath, softwareRendererReleaseTag, softwareRendererVersion } from "./software-renderer-cache.ts";
const expectedMembers = new Set(["libvulkan_lvp.so", "lvp_icd.json"]);
export type SoftwareRendererInstallOptions = SoftwareRendererCacheOptions & {
  readonly fetch?: typeof globalThis.fetch;
  readonly platform?: NodeJS.Platform;
};
export type SoftwareRendererInstallResult = { readonly path: string; readonly downloaded: boolean };

export async function installSoftwareRenderer(options: SoftwareRendererInstallOptions = {}): Promise<SoftwareRendererInstallResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "linux" || !softwareRendererExpectedHashes[arch]) throw softwareRendererError(
    "VGPU-NODE-SOFTWARE-RENDERER-UNSUPPORTED",
    `The portable software renderer is not available for ${platform}/${arch}; it currently supports Linux x64 and arm64.`,
  );
  const cached = getCachedSoftwareRenderer({ ...options, arch });
  if (cached) return { path: cached, downloaded: false };
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw softwareRendererError("VGPU-NODE-SOFTWARE-RENDERER-DOWNLOAD", "Software renderer download failed: this Node.js runtime does not provide fetch.");

  const destination = softwareRendererCacheDirectory({ ...options, arch });
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(temporary, { mode: 0o700 });
  const asset = `mesa-lavapipe-25.0.7-linux-${arch}.tar.gz`;
  const archive = join(temporary, asset);
  const url = `https://github.com/vercel-labs/vgpu/releases/download/${softwareRendererReleaseTag}/${asset}`;
  try {
    const response = await fetchImpl(url, { redirect: "follow" });
    if (!response.ok || !response.body) throw new Error(`GitHub release asset returned HTTP ${response.status} ${response.statusText}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    verifySoftwareRendererArchive(archive, options.expectedSha256 ?? softwareRendererExpectedHash(arch));
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    if (listing.status !== 0) throw new Error(`tar could not inspect the archive: ${listing.stderr}`);
    const members = listing.stdout.trim().split(/\r?\n/u);
    if (members.length !== expectedMembers.size || members.some((member) => !expectedMembers.has(member))) throw new Error(`archive contains unexpected paths: ${members.join(", ")}`);
    const extraction = spawnSync("tar", ["-xzf", archive, "-C", temporary, "--no-same-owner", "--no-same-permissions"], { encoding: "utf8" });
    if (extraction.status !== 0) throw new Error(`tar could not extract the archive: ${extraction.stderr}`);
    for (const path of [join(temporary, "lvp_icd.json"), join(temporary, "libvulkan_lvp.so")]) assertSoftwareRendererRegularFile(path);
    chmodSync(join(temporary, "lvp_icd.json"), 0o600);
    chmodSync(join(temporary, "libvulkan_lvp.so"), 0o700);
    try { renameSync(temporary, destination); }
    catch (cause) { if (!getCachedSoftwareRenderer({ ...options, arch })) throw cause; }
    return { path: softwareRendererIcdPath({ ...options, arch }), downloaded: true };
  } catch (cause) {
    if (cause instanceof VGPUError) throw cause;
    throw softwareRendererError("VGPU-NODE-SOFTWARE-RENDERER-DOWNLOAD", `Software renderer download failed: ${String(cause)}`, cause);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
