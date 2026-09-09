import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export const SNAPSHOT_ENV = "linux-x64-vulkan-v1";
export const SNAPSHOT_ROOTS = [
  "packages/vgpu-api/tests/scene/primitives/__snapshots__",
  "packages/render/tests/inspect/__snapshots__",
  "packages/render/tests/edit/__snapshots__",
];

export function assertSnapshotEnvironment(env = process.env, platform = process.platform, arch = process.arch) {
  if (env.VGPU_WRITE_SNAPSHOTS) throw new Error("VGPU_WRITE_SNAPSHOTS is retired. Use pnpm snapshots:update; references require review.");
  if (!["check", "update"].includes(env.VGPU_SNAPSHOT_MODE)) throw new Error("Use pnpm snapshots:check or pnpm snapshots:update.");
  if (platform !== "linux" || arch !== "x64" || env.VGPU_SNAPSHOT_ENV !== SNAPSHOT_ENV
    || env.VGPU_DAWN_FLAGS !== "backend=vulkan"
    || env.GALLIUM_OVERRIDE_CPU_CAPS !== "nosse" || env.LP_NATIVE_VECTOR_WIDTH !== "128"
    || env.VK_DRIVER_FILES !== "/usr/share/vulkan/icd.d/lvp_icd.json"
    || env.VK_ICD_FILENAMES !== env.VK_DRIVER_FILES) {
    throw new Error(`Visual references require ${SNAPSHOT_ENV}. Use pnpm snapshots:check; ordinary local GPU tests do not compare these images.`);
  }
}

export function snapshotPath(directory, name) {
  if (!SNAPSHOT_ROOTS.includes(directory) || !/^[a-z0-9][a-z0-9.-]*\.png$/.test(name)) {
    throw new Error("Invalid visual snapshot path");
  }
  return `${directory}/${name}`;
}

/** Repo-only oracle. Update writes review artifacts, never the committed baseline. */
export async function compareVisualSnapshot(directory, name, pngBytes, options = {}) {
  const env = options.env ?? process.env;
  assertSnapshotEnvironment(env, options.platform ?? process.platform, options.arch ?? process.arch);
  const root = options.root ?? process.cwd();
  const path = snapshotPath(directory, name);
  const artifactRoot = join(root, "artifacts/visual-snapshots");
  const actualBytes = Buffer.from(pngBytes);
  const actual = PNG.sync.read(actualBytes);
  if (actual.width !== 256 || actual.height !== 256) throw new Error(`${path}: expected a 256x256 render`);
  let expectedBytes;
  try { expectedBytes = await readFile(join(root, path)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const expected = expectedBytes && PNG.sync.read(expectedBytes);
  const sameSize = expected && expected.width === actual.width && expected.height === actual.height;
  const matched = Boolean(sameSize && actual.data.equals(expected.data));
  const status = matched ? "matched" : expected ? "changed" : "missing";
  let mismatchedPixels = sameSize ? 0 : null, maxChannelDelta = sameSize ? 0 : null;
  if (sameSize) for (let pixel = 0; pixel < actual.data.length; pixel += 4) {
    let delta = 0;
    for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(actual.data[pixel + channel] - expected.data[pixel + channel]));
    if (delta) mismatchedPixels++;
    maxChannelDelta = Math.max(maxChannelDelta, delta);
  }
  const report = { path, status, mismatchedPixels, maxChannelDelta, baselineSha256: expectedBytes ? sha(expectedBytes) : null, actualSha256: sha(actualBytes) };
  const destination = join(artifactRoot, "images", path.slice(0, -4));
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "actual.png"), actualBytes);
  if (expectedBytes) await writeFile(join(destination, "before.png"), expectedBytes);
  if (sameSize) {
    const diff = new PNG({ width: actual.width, height: actual.height });
    pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, { threshold: 0, includeAA: true });
    await writeFile(join(destination, "diff.png"), PNG.sync.write(diff));
  }
  if (!matched) {
    const candidate = join(artifactRoot, "candidates", path);
    await mkdir(dirname(candidate), { recursive: true });
    await writeFile(candidate, actualBytes);
  }
  await writeFile(join(destination, "result.json"), JSON.stringify(report, null, 2));
  if (!matched && env.VGPU_SNAPSHOT_MODE === "check") {
    const message = `${path}: ${status} visual snapshot. Review before/actual/diff in the visual-snapshots artifact. Intentional change? Run pnpm snapshots:update.`;
    if (options.onMismatch) options.onMismatch(message);
    else throw new Error(message);
  }
  return report;
}

function sha(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
