import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Exercise the dependency actually used by Fumadocs, including both published
// module formats and its file API. A child-process deadline is essential: a
// parser's synchronous infinite loop also prevents in-process timers firing.
const fumadocsRequire = createRequire(
  realpathSync(
    new URL(
      "../apps/docs/node_modules/fumadocs-core/package.json",
      import.meta.url
    )
  )
);
const packageRoot = dirname(dirname(fumadocsRequire.resolve("image-size")));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

type Format = "icns" | "jxl" | "heif";
type Api = "buffer" | "file" | "type";
type Loader = "import" | "require";

const childSource = String.raw`
  import { createRequire } from "node:module";
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  import { pathToFileURL } from "node:url";

  const [root, loader, api, format, hex, inputPath] = process.argv.slice(1);
  const require = createRequire(join(root, "package.json"));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const exportKey = api === "file" ? "./fromFile" : api === "type" ? "./types/*" : ".";
  const entry = manifest.exports[exportKey][loader].default.replace("*", format);
  const filename = join(root, entry);
  const exported = loader === "import" ? await import(pathToFileURL(filename).href) : require(filename);
  const input = Buffer.from(hex, "hex");
  try {
    let value;
    if (api === "file") {
      value = await exported.imageSizeFromFile(inputPath);
    } else if (api === "type") {
      value = exported[format.toUpperCase()].calculate(input);
    } else {
      value = exported.imageSize(input);
    }
    process.stdout.write(JSON.stringify({ value }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ rejected: true, name: error.name }));
  }
`;

function parseInChild(input: Buffer, format: Format, api: Api, loader: Loader) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), "vgpu-image-size-test-")
  );
  const inputPath = join(temporaryDirectory, "input.bin");
  writeFileSync(inputPath, input);
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=64",
        "--input-type=module",
        "--eval",
        childSource,
        resolve(packageRoot),
        loader,
        api,
        format,
        input.toString("hex"),
        inputPath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 3_000,
        killSignal: "SIGKILL",
        maxBuffer: 16_384,
      }
    );
    expect(
      child.error,
      "image parsing must finish within its external deadline"
    ).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout) as {
      value?: { width: number; height: number; images?: unknown[] };
      rejected?: boolean;
    };
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function icns(entryLength: number) {
  const input = Buffer.alloc(16);
  input.write("icns");
  input.writeUInt32BE(input.length, 4);
  input.write("icp4", 8);
  input.writeUInt32BE(entryLength, 12);
  return input;
}

function box(name: string, payload: Buffer) {
  const output = Buffer.alloc(8 + payload.length);
  output.writeUInt32BE(output.length);
  output.write(name, 4);
  payload.copy(output, 8);
  return output;
}

function jxl(partialLength?: number) {
  const signature = box("JXL ", Buffer.from([13, 10, 135, 10]));
  const fileType = box("ftyp", Buffer.from("jxl \0\0\0\0jxl ", "binary"));
  // Minimal small-image codestream header describing 8 x 8 pixels.
  const partial = box("jxlp", Buffer.from([0, 0, 0, 0, 255, 10, 1, 0]));
  if (partialLength !== undefined) partial.writeUInt32BE(partialLength);
  return Buffer.concat([signature, fileType, partial]);
}

function heif(spatialLength?: number) {
  const dimensions = Buffer.alloc(12);
  dimensions.writeUInt32BE(32, 4);
  dimensions.writeUInt32BE(24, 8);
  const spatial = box("ispe", dimensions);
  if (spatialLength !== undefined) spatial.writeUInt32BE(spatialLength);
  return Buffer.concat([
    box("ftyp", Buffer.from("heic\0\0\0\0", "binary")),
    box(
      "meta",
      Buffer.concat([Buffer.alloc(4), box("iprp", box("ipco", spatial))])
    ),
  ]);
}

for (const loader of ["import", "require"] as const) {
  for (const api of ["buffer", "file", "type"] as const) {
    test(`image-size ${loader}/${api} rejects a non-advancing ICNS entry`, () => {
      expect(parseInChild(icns(0), "icns", api, loader).rejected).toBe(true);
    });
    test(`image-size ${loader}/${api} keeps valid ICNS dimensions`, () => {
      expect(parseInChild(icns(8), "icns", api, loader).value).toMatchObject({
        width: 16,
        height: 16,
      });
    });
    test(`image-size ${loader}/${api} rejects a non-advancing JXL partial box`, () => {
      expect(parseInChild(jxl(0), "jxl", api, loader).rejected).toBe(true);
    });
    test(`image-size ${loader}/${api} keeps valid JXL dimensions`, () => {
      expect(parseInChild(jxl(), "jxl", api, loader).value).toMatchObject({
        width: 8,
        height: 8,
      });
    });
    test(`image-size ${loader}/${api} rejects a non-advancing HEIF spatial box`, () => {
      expect(parseInChild(heif(0), "heif", api, loader).rejected).toBe(true);
    });
    test(`image-size ${loader}/${api} keeps valid HEIF dimensions`, () => {
      expect(parseInChild(heif(), "heif", api, loader).value).toMatchObject({
        width: 32,
        height: 24,
      });
    });
    test(`image-size ${loader}/${api} rejects undersized and oversized ICNS entries`, () => {
      for (const length of [1, 7, 9, 0xffffffff]) {
        expect(
          parseInChild(icns(length), "icns", api, loader).rejected,
          `length ${length}`
        ).toBe(true);
      }
    });
    test(`image-size ${loader}/${api} rejects truncated ICNS headers`, () => {
      for (const length of [4, 9, 15]) {
        expect(
          parseInChild(icns(8).subarray(0, length), "icns", api, loader)
            .rejected,
          `length ${length}`
        ).toBe(true);
      }
    });
    test(`image-size ${loader}/${api} requires all eight ICNS entry-header bytes`, () => {
      const input = icns(6);
      input.writeUInt32BE(14, 4);
      expect(parseInChild(input, "icns", api, loader).rejected).toBe(true);
    });
    test(`image-size ${loader}/${api} rejects truncated JXL partial boxes`, () => {
      for (const length of [1, 8, 11, 0xffffffff]) {
        expect(
          parseInChild(jxl(length), "jxl", api, loader).rejected,
          `length ${length}`
        ).toBe(true);
      }
    });
    test(`image-size ${loader}/${api} rejects undersized HEIF spatial boxes`, () => {
      for (const length of [1, 8, 19, 0xffffffff]) {
        expect(
          parseInChild(heif(length), "heif", api, loader).rejected,
          `length ${length}`
        ).toBe(true);
      }
    });
    test(`image-size ${loader}/${api} preserves multi-entry ICNS images`, () => {
      const input = Buffer.concat([icns(8), icns(8).subarray(8)]);
      input.writeUInt32BE(input.length, 4);
      expect(
        parseInChild(input, "icns", api, loader).value?.images
      ).toHaveLength(2);
      input.writeUInt32BE(0, 20);
      expect(parseInChild(input, "icns", api, loader).rejected).toBe(true);
    });
    test(`image-size ${loader}/${api} preserves partial ICNS header inspection`, () => {
      // fromFile intentionally reads at most 512 KiB. The parser can derive
      // dimensions from a complete entry header without the entry's payload.
      const input = icns(128);
      input.writeUInt32BE(136, 4);
      expect(parseInChild(input, "icns", api, loader).value).toMatchObject({
        width: 16,
        height: 16,
      });
    });
    test(`image-size ${loader}/${api} preserves split JXL codestreams`, () => {
      const input = Buffer.concat([
        jxl().subarray(0, 32),
        box("jxlp", Buffer.from([0, 0, 0, 0, 255, 10])),
        box("jxlp", Buffer.from([128, 0, 0, 1, 1, 0])),
      ]);
      expect(parseInChild(input, "jxl", api, loader).value).toMatchObject({
        width: 8,
        height: 8,
      });
    });
    test(`image-size ${loader}/${api} rejects HEIF spatial data beyond its parent`, () => {
      const input = heif();
      input.writeUInt32BE(27, 36); // ipco ends one byte before its ispe child.
      expect(parseInChild(input, "heif", api, loader).rejected).toBe(true);
    });
    test(`image-size ${loader}/${api} preserves multiple HEIF spatial entries`, () => {
      const input = Buffer.concat([heif(), heif().subarray(44)]);
      for (const offset of [16, 28, 36]) {
        input.writeUInt32BE(input.readUInt32BE(offset) + 20, offset);
      }
      expect(
        parseInChild(input, "heif", api, loader).value?.images
      ).toHaveLength(2);
      input.writeUInt32BE(0, 64);
      expect(parseInChild(input, "heif", api, loader).rejected).toBe(true);
    });
  }
}
