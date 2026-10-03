import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Stable template-cache identity for one prepared tarball directory.
 *
 * The source key separates packed code while the docs hash separates the two
 * experiment corpora. Volatile pack metadata and arm labels are deliberately
 * excluded so an identical repack can reuse its template.
 */
export function tarballsFingerprint(directory) {
  const manifestPath = join(directory, "tarballs.json");
  if (!existsSync(manifestPath)) return "no-tarballs";
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return `vgpu-${manifest.sourceKey}-${manifest.sceneGuidance?.docsSha256 ?? "default-corpus"}`;
  } catch {
    // A revalidation key must never be the thing that fails a run; a distinct
    // constant just forces one rebuild.
    return "unreadable-manifest";
  }
}
