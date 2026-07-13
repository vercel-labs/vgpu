import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface SnapshotDiffOptions {
  readonly maxDiffRatio?: number;
  readonly pixelmatchThreshold?: number;
  readonly update?: boolean;
}

export interface SnapshotDiffResult {
  readonly status: "created" | "matched" | "updated";
  readonly mismatchedPixels: number;
  readonly ratio: number;
  readonly actualPath: string;
  readonly diffPath: string;
}

/** Compares deterministic RGBA8 pixels against a committed PNG baseline. */
export async function comparePixelSnapshot(path: string, bytes: Uint8Array, width: number, height: number, options: SnapshotDiffOptions = {}): Promise<SnapshotDiffResult> {
  const actualPath = artifactPath(path, "actual");
  const diffPath = artifactPath(path, "diff");

  if (!existsSync(path)) {
    if (!options.update) throw new Error(`Snapshot baseline is missing.\n${snapshotFixit(path, actualPath, diffPath)}`);
    await writePixelSnapshot(path, bytes, width, height);
    return { status: "created", mismatchedPixels: 0, ratio: 0, actualPath, diffPath };
  }

  const expected = PNG.sync.read(await readFile(path));
  assertDimensions(path, expected, width, height);
  const actual = pngFromRgba(bytes, width, height);
  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(expected.data, actual.data, diff.data, width, height, { threshold: options.pixelmatchThreshold ?? 0.1 });
  const ratio = mismatchedPixels / (width * height);
  if (ratio <= (options.maxDiffRatio ?? 0)) return { status: "matched", mismatchedPixels, ratio, actualPath, diffPath };

  if (options.update) {
    await writePixelSnapshot(path, bytes, width, height);
    return { status: "updated", mismatchedPixels, ratio, actualPath, diffPath };
  }

  await writePixelSnapshot(actualPath, bytes, width, height);
  await writeFile(diffPath, PNG.sync.write(diff));
  throw new Error(`Snapshot mismatch: ${mismatchedPixels} pixels differ (ratio ${ratio}).\n${snapshotFixit(path, actualPath, diffPath)}`);
}

/** Writes an RGBA8 PNG baseline for a deterministic pixel snapshot. */
export async function writePixelSnapshot(path: string, bytes: Uint8Array, width: number, height: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(pngFromRgba(bytes, width, height)));
}

function snapshotFixit(path: string, actualPath: string, diffPath: string): string {
  return [
    `Baseline: ${path}`,
    `Actual: ${actualPath}`,
    `Diff: ${diffPath}`,
    "Fix: regenerate the committed baseline with `vgpu snapshot --update` inside the Docker GPU harness, then commit the PNG.",
  ].join("\n");
}

function artifactPath(path: string, suffix: string): string {
  return path.replace(/\.png$/u, `.${suffix}.png`);
}

function pngFromRgba(bytes: Uint8Array, width: number, height: number): PNG {
  const expectedLength = width * height * 4;
  if (bytes.length !== expectedLength) throw new Error(`expected ${expectedLength} RGBA8 bytes, got ${bytes.length}`);
  const png = new PNG({ width, height });
  png.data.set(bytes);
  return png;
}

function assertDimensions(path: string, expected: PNG, width: number, height: number): void {
  if (expected.width === width && expected.height === height) return;
  throw new Error(`${path} is ${expected.width}x${expected.height}; expected ${width}x${height}`);
}
