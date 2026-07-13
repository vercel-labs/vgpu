import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export function rgbaToPng(bytes, width, height) {
  const png = new PNG({ width, height });
  png.data.set(bytes);
  return png;
}

export async function writePng(path, bytes, width, height) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, PNG.sync.write(rgbaToPng(bytes, width, height)));
}

export async function comparePngSnapshot(path, bytes, width, height, options = {}) {
  const actualPath = artifactPath(path, "actual");
  const diffPath = artifactPath(path, "diff");

  if (!existsSync(path)) {
    if (!options.update) return { status: "missing", mismatchedPixels: 0, ratio: 0, actualPath, diffPath };
    await writePng(path, bytes, width, height);
    return { status: "created", mismatchedPixels: 0, ratio: 0, actualPath, diffPath };
  }

  const expected = PNG.sync.read(await readFile(path));
  assertSameDimensions(path, expected, width, height);
  const actual = rgbaToPng(bytes, width, height);
  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(expected.data, actual.data, diff.data, width, height, { threshold: options.pixelmatchThreshold ?? 0.1 });
  const ratio = mismatchedPixels / (width * height);
  if (ratio <= (options.maxDiffRatio ?? 0)) return { status: "matched", mismatchedPixels, ratio, actualPath, diffPath };

  if (options.update) {
    await writePng(path, bytes, width, height);
    return { status: "updated", mismatchedPixels, ratio, actualPath, diffPath };
  }

  await writePng(actualPath, bytes, width, height);
  await writeFile(diffPath, PNG.sync.write(diff));
  return { status: "different", mismatchedPixels, ratio, actualPath, diffPath };
}

export function snapshotFixit(path, actualPath, diffPath) {
  return [
    `Baseline: ${path}`,
    `Actual: ${actualPath}`,
    `Diff: ${diffPath}`,
    "Fix: regenerate the committed baseline with `vgpu snapshot --update` inside the Docker GPU harness, then commit the PNG.",
  ].join("\n");
}

function artifactPath(path, suffix) {
  return path.replace(/\.png$/u, `.${suffix}.png`);
}

function assertSameDimensions(path, expected, width, height) {
  if (expected.width === width && expected.height === height) return;
  throw new Error(`${path} is ${expected.width}x${expected.height}; expected ${width}x${height}`);
}
