import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { VGPUError } from "@vgpu/core";

export const softwareRendererReleaseTag = "lavapipe-v25.0.7-vgpu.1";
export const softwareRendererVersion = "25.0.7-vgpu.1";
export const softwareRendererExpectedHashes: Readonly<Record<string, string>> = {
  arm64: "eac1477d6404af2d63fc08104e980d0cbbf657470c966a0bc638099c00d3dcac",
  x64: "8c97d7b8b9ac1598dbedf30f23cdf37eb6ae5f2b062e38b7d8bb7d84549a5b82",
};
const libraryHashes: Readonly<Record<string, string>> = {
  arm64: "946bfbc0f4166ae6131a9a4e57d90b9d6484dc25f263087e98df1486be76d381",
  x64: "2c05c5bfa119b81a68b84c34ae8249d0ee1fc07606f5c40226309aef889b6126",
};
const icdHash = "b54fe7421c8994a63aeecc16a80f6718e523b6c138fa7e5893bf3cb43923da1c";
export type SoftwareRendererCacheOptions = { readonly cacheRoot?: string; readonly arch?: string; readonly expectedSha256?: string };

export function softwareRendererCacheDirectory(options: Pick<SoftwareRendererCacheOptions, "cacheRoot" | "arch"> = {}): string {
  const root = options.cacheRoot ?? process.env.VGPU_CACHE_DIR ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(root, "vgpu", "software-renderer", softwareRendererVersion, `linux-${options.arch ?? process.arch}`);
}
export function softwareRendererIcdPath(options: Pick<SoftwareRendererCacheOptions, "cacheRoot" | "arch"> = {}): string {
  return join(softwareRendererCacheDirectory(options), "lvp_icd.json");
}
export function softwareRendererArchivePath(options: Pick<SoftwareRendererCacheOptions, "cacheRoot" | "arch"> = {}): string {
  return join(softwareRendererCacheDirectory(options), `mesa-lavapipe-25.0.7-linux-${options.arch ?? process.arch}.tar.gz`);
}
export function softwareRendererExpectedHash(arch: string): string {
  const hash = softwareRendererExpectedHashes[arch];
  if (!hash) throw softwareRendererError("VGPU-NODE-SOFTWARE-RENDERER-UNSUPPORTED", `No portable software renderer checksum is pinned for ${arch}.`);
  return hash;
}
export function getCachedSoftwareRenderer(options: SoftwareRendererCacheOptions = {}): string | null {
  const archive = softwareRendererArchivePath(options);
  const icd = softwareRendererIcdPath(options);
  const library = join(softwareRendererCacheDirectory(options), "libvulkan_lvp.so");
  if (![archive, icd, library].every(existsSync)) return null;
  for (const path of [archive, icd, library]) assertSoftwareRendererRegularFile(path);
  const arch = options.arch ?? process.arch;
  verifySoftwareRendererArchive(archive, options.expectedSha256 ?? softwareRendererExpectedHash(arch));
  verifySoftwareRendererFiles(softwareRendererCacheDirectory(options), arch);
  return icd;
}
export function verifySoftwareRendererFiles(directory: string, arch: string = process.arch): void {
  const icd = join(directory, "lvp_icd.json");
  const library = join(directory, "libvulkan_lvp.so");
  assertSoftwareRendererRegularFile(icd);
  assertSoftwareRendererRegularFile(library);
  verifyFileHash(icd, icdHash);
  verifyFileHash(library, libraryHashes[arch] ?? "");
}
export function verifySoftwareRendererArchive(path: string, expected: string): void {
  assertSoftwareRendererRegularFile(path);
  verifyFileHash(path, expected);
}
function verifyFileHash(path: string, expected: string): void {
  const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (actual !== expected) throw softwareRendererError("VGPU-NODE-SOFTWARE-RENDERER-CHECKSUM", `Refusing software renderer ${path}: SHA-256 ${actual} does not match pinned ${expected}.`);
}
export function createPrivateSoftwareRendererCopy(icd: string, arch = process.arch): { readonly path: string; readonly cleanup: () => void } {
  const sourceDirectory = dirname(icd);
  const directory = mkdtempSync(join(tmpdir(), "vgpu-lavapipe-load-"));
  chmodSync(directory, 0o700);
  try {
    copyVerified(join(sourceDirectory, "lvp_icd.json"), join(directory, "lvp_icd.json"), icdHash, 0o600);
    copyVerified(join(sourceDirectory, "libvulkan_lvp.so"), join(directory, "libvulkan_lvp.so"), libraryHashes[arch] ?? "", 0o700);
    return { path: join(directory, "lvp_icd.json"), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (cause) {
    rmSync(directory, { recursive: true, force: true });
    throw cause;
  }
}
function copyVerified(source: string, destination: string, expected: string, mode: number): void {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const input = openSync(source, constants.O_RDONLY | noFollow);
  const output = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
      let offset = 0;
      while (offset < count) offset += writeSync(output, buffer, offset, count - offset);
    }
  } finally { closeSync(output); closeSync(input); }
  const actual = hash.digest("hex");
  if (actual !== expected) throw softwareRendererError("VGPU-NODE-SOFTWARE-RENDERER-CHECKSUM", `Refusing software renderer ${source}: SHA-256 ${actual} does not match pinned ${expected}.`);
}
export function assertSoftwareRendererRegularFile(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) throw softwareRendererError("VGPU-NODE-SOFTWARE-RENDERER-CHECKSUM", `Refusing software renderer cache path ${path}: it is not a regular non-symlink file.`);
}
export function softwareRendererError(code: string, message: string, cause?: unknown): VGPUError {
  return new VGPUError({ code, message, fix: "Run `npx vgpu install-software-renderer` with network access.", where: "installSoftwareRenderer", cause });
}
