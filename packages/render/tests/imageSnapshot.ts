import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { expect } from "vitest";
import { PNG } from "pngjs";

interface ImageSnapshotOptions {
  readonly testName: string;
  readonly threshold: number;
}

expect.extend({
  async toMatchImageSnapshot(received: Uint8Array, options: ImageSnapshotOptions) {
    const size = imageSize(received);
    const dir = join(process.cwd(), "packages/render/tests/__snapshots__");
    const expectedPath = join(dir, `${options.testName}.png`);
    await mkdir(dir, { recursive: true });
    if (!existsSync(expectedPath)) {
      await writeFile(expectedPath, encodePng(received, size.width, size.height));
      console.info(`[NEW SNAPSHOT] ${expectedPath}`);
      return { pass: true, message: () => `created ${expectedPath}` };
    }
    const expected = PNG.sync.read(await readFile(expectedPath));
    const actual = toPng(received, size.width, size.height);
    const diff = new PNG({ width: size.width, height: size.height });
    const mismatched = pixelmatch(expected.data, actual.data, diff.data, size.width, size.height, { threshold: 0.1 });
    const ratio = mismatched / (size.width * size.height);
    if (ratio <= options.threshold) return { pass: true, message: () => `diff ratio ${ratio}` };
    await writeFile(join(dir, `${options.testName}.actual.png`), PNG.sync.write(actual));
    await writeFile(join(dir, `${options.testName}.diff.png`), PNG.sync.write(diff));
    return { pass: false, message: () => `image diff ratio ${ratio} exceeded ${options.threshold}` };
  },
});

function imageSize(bytes: Uint8Array): { width: number; height: number } {
  const pixels = bytes.length / 4;
  const side = Math.sqrt(pixels);
  if (!Number.isInteger(side)) throw new Error(`Cannot infer square RGBA image size from ${bytes.length} bytes.`);
  return { width: side, height: side };
}

function encodePng(bytes: Uint8Array, width: number, height: number): Buffer {
  return PNG.sync.write(toPng(bytes, width, height));
}

function toPng(bytes: Uint8Array, width: number, height: number): PNG {
  const png = new PNG({ width, height });
  png.data.set(bytes);
  return png;
}

declare module "vitest" {
  interface Assertion<T = unknown> {
    toMatchImageSnapshot(options: ImageSnapshotOptions): Promise<T>;
  }
  interface AsymmetricMatchersContaining {
    toMatchImageSnapshot(options: ImageSnapshotOptions): unknown;
  }
}
