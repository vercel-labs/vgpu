import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { expect } from "vitest";
import { PNG } from "pngjs";

interface ImageSnapshotOptions {
  readonly testName: string;
  readonly width: number;
  readonly height: number;
  readonly threshold: number;
}

expect.extend({
  async toMatchImageSnapshot(received: Uint8Array, options: ImageSnapshotOptions) {
    const expectedLength = options.width * options.height * 4;
    if (received.length !== expectedLength) {
      return { pass: false, message: () => `expected ${expectedLength} RGBA8 bytes, got ${received.length}` };
    }
    const dir = join(process.cwd(), "packages/render/tests/__snapshots__");
    const expectedPath = join(dir, `${options.testName}.png`);
    await mkdir(dir, { recursive: true });
    if (!existsSync(expectedPath)) {
      await writeFile(expectedPath, encodePng(received, options.width, options.height));
      console.info(`[NEW SNAPSHOT] ${expectedPath}`);
      return { pass: true, message: () => `created ${expectedPath}` };
    }
    const expected = PNG.sync.read(await readFile(expectedPath));
    const actual = toPng(received, options.width, options.height);
    const diff = new PNG({ width: options.width, height: options.height });
    const mismatched = pixelmatch(expected.data, actual.data, diff.data, options.width, options.height, { threshold: 0.1 });
    const ratio = mismatched / (options.width * options.height);
    if (ratio <= options.threshold) return { pass: true, message: () => `diff ratio ${ratio}` };
    await writeFile(join(dir, `${options.testName}.actual.png`), PNG.sync.write(actual));
    await writeFile(join(dir, `${options.testName}.diff.png`), PNG.sync.write(diff));
    return { pass: false, message: () => `image diff ratio ${ratio} exceeded ${options.threshold}` };
  },
});

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
