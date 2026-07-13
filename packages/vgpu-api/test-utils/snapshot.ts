import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface SnapshotDiffOptions {
  readonly maxDiffRatio?: number;
  readonly pixelmatchThreshold?: number;
}

export interface SnapshotDiffResult {
  readonly status: "created" | "matched" | "different";
  readonly mismatchedPixels: number;
  readonly ratio: number;
}

/** Compares deterministic RGBA8 pixels against a committed PNG baseline. */
export async function comparePixelSnapshot(path: string, bytes: Uint8Array, width: number, height: number, options: SnapshotDiffOptions = {}): Promise<SnapshotDiffResult> {
  if (!existsSync(path)) {
    await writePixelSnapshot(path, bytes, width, height);
    return { status: "created", mismatchedPixels: 0, ratio: 0 };
  }

  const expected = PNG.sync.read(await readFile(path));
  assertDimensions(path, expected, width, height);
  const actual = pngFromRgba(bytes, width, height);
  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(expected.data, actual.data, diff.data, width, height, { threshold: options.pixelmatchThreshold ?? 0.1 });
  const ratio = mismatchedPixels / (width * height);
  return ratio <= (options.maxDiffRatio ?? 0) ? { status: "matched", mismatchedPixels, ratio } : { status: "different", mismatchedPixels, ratio };
}

/** Writes an RGBA8 PNG baseline for a deterministic pixel snapshot. */
export async function writePixelSnapshot(path: string, bytes: Uint8Array, width: number, height: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(pngFromRgba(bytes, width, height)));
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
