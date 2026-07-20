import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  readonly libc?: "glibc" | "musl";
  readonly quiet?: boolean;
};

export type DawnInstallResult = { readonly path: string; readonly downloaded: boolean };

export function dawnCachePath(options: Pick<DawnInstallOptions, "cacheRoot"> = {}): string {
  const root = options.cacheRoot ?? process.env.VGPU_CACHE_DIR ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(root, "vgpu", "dawn", dawnArtifactVersion, "linux-arm64-gnu", dawnAssetName);
}

export function verifyDawnBinary(path: string, expectedSha256 = dawnAssetSha256): void {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expectedSha256) {
    throw new VGPUError({
      code: "VGPU-NODE-PREBUILD-CHECKSUM",
      message: `Refusing Dawn prebuild ${path}: SHA-256 ${actual} does not match pinned ${expectedSha256}.`,
      fix: `Delete the file and retry. ${manualInstall}`,
      where: "installDawn",
    });
  }
}

export function getCachedDawnBinary(options: Pick<DawnInstallOptions, "cacheRoot" | "expectedSha256"> = {}): string | null {
  const path = dawnCachePath(options);
  if (!existsSync(path)) return null;
  verifyDawnBinary(path, options.expectedSha256);
  return path;
}

export async function installDawn(options: DawnInstallOptions = {}): Promise<DawnInstallResult> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const cached = getCachedDawnBinary(options);
  if (cached) return { path: cached, downloaded: false };

  const unsupportedReason = getUnsupportedReason(platform, arch, options.libc);
  if (unsupportedReason) throw prebuildMissing(unsupportedReason, undefined, platform, arch);

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw prebuildMissing("blocked: this Node.js runtime does not provide fetch", undefined, platform, arch);

  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  try {
    const download = token ? await resolveAuthenticatedAsset(fetchImpl, token) : { url: publicAssetUrl, headers: {} };
    const response = await fetchImpl(download.url, { redirect: "follow", headers: download.headers });
    if (!response.ok || !response.body) {
      throw new Error(`GitHub returned HTTP ${response.status} ${response.statusText}`);
    }

    const destination = dawnCachePath(options);
    mkdirSync(dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    try {
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temporary, { mode: 0o600 }));
      verifyDawnBinary(temporary, options.expectedSha256);
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
    return { path: destination, downloaded: true };
  } catch (cause) {
    if (cause instanceof VGPUError) throw cause;
    throw prebuildMissing(downloadFailureReason(cause), cause, platform, arch);
  }
}

async function resolveAuthenticatedAsset(fetchImpl: Fetch, token: string): Promise<{ url: string; headers: Record<string, string> }> {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "@vgpu/adapter-node" };
  const response = await fetchImpl(githubReleasesApiUrl, { headers });
  if (!response.ok) throw new Error(`GitHub release API returned HTTP ${response.status} ${response.statusText}`);
  const releases = (await response.json()) as { tag_name?: string; assets?: { name?: string; url?: string }[] }[];
  const release = releases.find((candidate) => candidate.tag_name === dawnReleaseTag);
  const asset = release?.assets?.find((candidate) => candidate.name === dawnAssetName);
  if (!asset?.url) throw new Error(`GitHub release ${dawnReleaseTag} does not contain ${dawnAssetName}`);
  return { url: asset.url, headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream", "User-Agent": "@vgpu/adapter-node" } };
}

function getUnsupportedReason(platform: NodeJS.Platform, arch: string, libc?: "glibc" | "musl"): string | null {
  if (platform !== "linux") return `unsupported platform ${platform}/${arch}; vgpu prebuilds currently target Linux arm64 only`;
  if (arch !== "arm64") return `unsupported platform ${platform}/${arch}; no vgpu prebuild is published for this CPU yet`;
  if (libc === "musl" || (libc === undefined && isMusl())) return "musl libc is unsupported; this prebuild requires glibc 2.31 or newer";
  return null;
}

function isMusl(): boolean {
  if (existsSync("/etc/alpine-release")) return true;
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] } | undefined;
    if (report?.header?.glibcVersionRuntime) return false;
    return report?.sharedObjects?.some((path: string) => /(?:^|\/)ld-musl-|libc\.musl-/u.test(path)) ?? false;
  } catch {
    return false;
  }
}

function downloadFailureReason(cause: unknown): string {
  const text = String(cause);
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|fetch failed|network|offline/iu.test(text)) return `offline: ${text}`;
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
