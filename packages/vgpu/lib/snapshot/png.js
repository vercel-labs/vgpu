import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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
  if (!existsSync(path)) {
    await writePng(path, bytes, width, height);
    return { status: "created", mismatchedPixels: 0, ratio: 0 };
  }

  const expected = PNG.sync.read(await readFile(path));
  assertSameDimensions(path, expected, width, height);
  const actual = rgbaToPng(bytes, width, height);
  const diff = new PNG({ width, height });
  const mismatchedPixels = pixelmatch(expected.data, actual.data, diff.data, width, height, { threshold: options.pixelmatchThreshold ?? 0.1 });
  const ratio = mismatchedPixels / (width * height);
  if (ratio <= (options.maxDiffRatio ?? 0)) return { status: "matched", mismatchedPixels, ratio };

  await writePng(path.replace(/\.png$/u, ".actual.png"), bytes, width, height);
  await writeFile(path.replace(/\.png$/u, ".diff.png"), PNG.sync.write(diff));
  return { status: "different", mismatchedPixels, ratio };
}

function assertSameDimensions(path, expected, width, height) {
  if (expected.width === width && expected.height === height) return;
  throw new Error(`${path} is ${expected.width}x${expected.height}; expected ${width}x${height}`);
}
