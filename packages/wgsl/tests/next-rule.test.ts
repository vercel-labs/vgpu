import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { compilerInventoryForModule } from "../src/loader-shared/compiler-inventory.ts";
import { wgslTurbopackRule } from "../src/next/index.ts";

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});

describe("wgslTurbopackRule", () => {
  test("returns a serialized rule with conservative defaults", () => {
    const rule = wgslTurbopackRule();

    expect(rule).toEqual({
      loaders: [{
        loader: expect.any(String),
        options: {
          minify: { whitespace: false, identifiers: "none" },
          vgpuImplementationFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        },
      }],
      as: "*.js",
    });
    expect(isAbsolute(rule.loaders[0].loader)).toBe(true);
    expect(() => JSON.stringify(rule)).not.toThrow();
  });

  test("normalizes every minify form and returns fresh copied values", () => {
    const omitted = wgslTurbopackRule();
    const explicitUndefined = wgslTurbopackRule({ minify: undefined });
    const disabled = wgslTurbopackRule({ minify: false });
    const safe = wgslTurbopackRule({ minify: true });
    const objectDefault = wgslTurbopackRule({ minify: {} });
    const input = { whitespace: false, identifiers: "safe" as const };
    const custom = wgslTurbopackRule({ minify: input });

    expect(omitted.loaders[0].options).toEqual(explicitUndefined.loaders[0].options);
    expect(omitted.loaders[0].options).toEqual(disabled.loaders[0].options);
    expect(safe.loaders[0].options.minify).toEqual({ whitespace: true, identifiers: "safe" });
    expect(objectDefault.loaders[0].options.minify).toEqual({ whitespace: true, identifiers: "none" });
    expect(custom.loaders[0].options.minify).toEqual({ whitespace: false, identifiers: "safe" });

    input.whitespace = true;
    expect(custom.loaders[0].options.minify).toEqual({ whitespace: false, identifiers: "safe" });
    expect(custom).not.toBe(wgslTurbopackRule({ minify: { whitespace: false, identifiers: "safe" } }));
    expect(custom.loaders).not.toBe(wgslTurbopackRule().loaders);
    expect(Object.getPrototypeOf(custom)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(custom.loaders[0].options)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(custom))).toEqual(custom);

    const mutableDefault = wgslTurbopackRule();
    (mutableDefault.loaders[0].options.minify as { whitespace: boolean }).whitespace = true;
    expect(wgslTurbopackRule().loaders[0].options.minify)
      .toEqual({ whitespace: false, identifiers: "none" });
  });

  test("rejects malformed helper options with actionable structured errors", () => {
    class Options {}
    const malformed: [unknown, string][] = [
      [null, "options"],
      [[], "options"],
      [new Options(), "options"],
      [{ loader: "elsewhere" }, "loader"],
      [{ vgpuImplementationFingerprint: "manual" }, "vgpuImplementationFingerprint"],
      [{ minify: null }, "minify"],
      [{ minify: [] }, "minify"],
      [{ minify: { extra: true } }, "minify.extra"],
      [{ minify: { whitespace: null } }, "minify.whitespace"],
    ];
    for (const [value, field] of malformed) {
      expect(() => wgslTurbopackRule(value as never)).toThrow(expect.objectContaining({
        code: "VGPU-WGSL-NEXT-OPTIONS",
        where: "wgslTurbopackRule",
        fix: "Pass only { minify?: boolean | { whitespace?: boolean; identifiers?: \"none\" | \"safe\" } }.",
        metadata: { field },
      }));
    }
    expect(() => wgslTurbopackRule({ minify: { identifiers: null } } as never)).toThrow(expect.objectContaining({
      code: "VGPU-WGSL-MINIFY-IDENTIFIERS",
      where: "wgslTurbopackRule",
      fix: "Use identifiers: \"none\" or \"safe\".",
    }));
    const hidden = {};
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(() => wgslTurbopackRule(hidden)).toThrow(expect.objectContaining({ code: "VGPU-WGSL-NEXT-OPTIONS" }));
    expect(() => wgslTurbopackRule({ [Symbol("option")]: true } as never))
      .toThrow(expect.objectContaining({ code: "VGPU-WGSL-NEXT-OPTIONS" }));
    expect(() => wgslTurbopackRule({ minify: { whitespace: undefined, identifiers: undefined } })).not.toThrow();
  });

  test("hashes the complete published compiler inventory without paths or mtimes", async () => {
    const first = await publishedFixture("first");
    const second = await publishedFixture("second");
    const identity = () => compilerInventoryForModule(pathToFileURL(first.helper).href, "wgslTurbopackRule").fingerprint;
    const original = identity();
    expect(compilerInventoryForModule(pathToFileURL(second.helper).href, "wgslTurbopackRule").fingerprint).toBe(original);

    await utimes(first.loaderIndex, new Date(1_000), new Date(2_000));
    expect(identity()).toBe(original);
    await writeFile(join(first.root, "dist/notes.docs.md"), "ignored docs");
    await writeFile(join(first.root, "dist/next/index.d.ts"), "ignored declarations");
    await writeFile(join(first.root, "dist/next/index.js.map"), "ignored map");
    expect(identity()).toBe(original);

    await writeFile(join(first.root, "dist/z.js"), "export const value = 1;\n");
    await writeFile(join(first.root, "dist/ä.js"), "export const value = 2;\n");
    const ordered = compilerInventoryForModule(pathToFileURL(first.helper).href, "wgslTurbopackRule").files;
    expect(ordered.findIndex((path) => path.endsWith("/z.js")))
      .toBeLessThan(ordered.findIndex((path) => path.endsWith("/ä.js")));
    await unlink(join(first.root, "dist/z.js"));
    await unlink(join(first.root, "dist/ä.js"));
    expect(identity()).toBe(original);

    await writeFile(first.loaderIndex, "export default function changed() {}\n");
    expect(identity()).not.toBe(original);
    await writeFile(first.loaderIndex, "export default function loader() {}\n");
    expect(identity()).toBe(original);

    const addition = join(first.root, "dist/transitive-added.js");
    await writeFile(addition, "export const added = true;\n");
    expect(identity()).not.toBe(original);
    await unlink(addition);
    expect(identity()).toBe(original);

    const linkedTarget = join(first.root, "dist/linked-target.bin");
    const linkedJavaScript = join(first.root, "dist/linked.js");
    await writeFile(linkedTarget, "export const linked = 1;\n");
    await symlink(linkedTarget, linkedJavaScript);
    const linkedIdentity = identity();
    expect(linkedIdentity).not.toBe(original);
    await writeFile(linkedTarget, "export const linked = 2;\n");
    expect(identity()).not.toBe(linkedIdentity);
    await unlink(linkedJavaScript);
    await unlink(linkedTarget);
    expect(identity()).toBe(original);

    await writeFile(first.helper, "export const helperChanged = true;\n");
    expect(identity()).not.toBe(original);
    await writeFile(first.helper, "export const helper = true;\n");
    expect(identity()).toBe(original);

    await writeFile(first.anchor, "// changed anchor\n");
    expect(identity()).not.toBe(original);
    await writeFile(first.anchor, "// metadata anchor\n");
    expect(identity()).toBe(original);

    await writeFile(first.manifest, manifestSource("0.5.1"));
    expect(identity()).not.toBe(original);
  });

  test("fails closed for missing assets and mismatched package ownership", async () => {
    const missing = await publishedFixture("missing");
    await unlink(missing.anchor);
    expect(() => compilerInventoryForModule(pathToFileURL(missing.helper).href, "wgslTurbopackRule")).toThrow(expect.objectContaining({
      code: "VGPU-WGSL-CACHE-IDENTITY",
      where: "wgslTurbopackRule",
      fix: expect.stringContaining("Reinstall the matching @vgpu/wgsl"),
      cause: expect.anything(),
      metadata: { path: missing.anchor },
    }));

    const wrong = await publishedFixture("wrong");
    await writeFile(wrong.manifest, manifestSource("0.5.0", "other-package"));
    expect(() => compilerInventoryForModule(pathToFileURL(wrong.helper).href, "wgslTurbopackRule")).toThrow(expect.objectContaining({
      code: "VGPU-WGSL-CACHE-IDENTITY",
      where: "wgslTurbopackRule",
      metadata: { path: wrong.manifest },
    }));

    const inconsistent = await publishedFixture("inconsistent");
    const manifest = JSON.parse(manifestSource());
    manifest.exports["./loader-webpack"].require = "./dist/loader-webpack/index.js";
    await writeFile(inconsistent.manifest, `${JSON.stringify(manifest)}\n`);
    expect(() => compilerInventoryForModule(pathToFileURL(inconsistent.helper).href, "wgslTurbopackRule")).toThrow(expect.objectContaining({
      code: "VGPU-WGSL-CACHE-IDENTITY",
      metadata: { path: inconsistent.manifest },
    }));

    const escaped = await publishedFixture("escaped");
    const outside = join(await realpath(await mkdtemp(join(tmpdir(), "vgpu-inventory-outside-"))), "outside.js");
    scratch.push(join(outside, ".."));
    await writeFile(outside, "export default function outside() {}\n");
    await unlink(escaped.prepared);
    await symlink(outside, escaped.prepared);
    expect(() => compilerInventoryForModule(pathToFileURL(escaped.helper).href, "wgslTurbopackRule")).toThrow(expect.objectContaining({
      code: "VGPU-WGSL-CACHE-IDENTITY",
      metadata: { path: outside },
    }));

    const escapedMember = await publishedFixture("escaped-member");
    await symlink(outside, join(escapedMember.root, "dist/escaped.js"));
    expect(() => compilerInventoryForModule(pathToFileURL(escapedMember.helper).href, "wgslTurbopackRule")).toThrow(expect.objectContaining({
      code: "VGPU-WGSL-CACHE-IDENTITY",
      metadata: { path: outside },
    }));

    const linkedDirectory = await publishedFixture("linked-directory");
    const linkedPath = join(linkedDirectory.root, "dist/linked-directory");
    await symlink(join(linkedDirectory.root, "dist"), linkedPath, "dir");
    expect(() => compilerInventoryForModule(pathToFileURL(linkedDirectory.helper).href, "wgslTurbopackRule")).toThrow(expect.objectContaining({
      code: "VGPU-WGSL-CACHE-IDENTITY",
      metadata: { path: linkedPath },
    }));
  });

  test("validates options before reading an unavailable compiler inventory", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-next-source-order-")));
    scratch.push(root);
    await cp(resolve("packages/wgsl/src"), join(root, "src"), { recursive: true });
    await writeFile(join(root, "package.json"), await readFile(resolve("packages/wgsl/package.json")));
    await unlink(join(root, "src/metadata.wgsl"));
    const copied = await import(/* @vite-ignore */ `${pathToFileURL(join(root, "src/next/index.ts")).href}?copy=${Date.now()}`) as {
      readonly wgslTurbopackRule: typeof wgslTurbopackRule;
    };

    expect(() => copied.wgslTurbopackRule({ unexpected: true } as never)).toThrow(expect.objectContaining({
      code: "VGPU-WGSL-NEXT-OPTIONS",
      where: "wgslTurbopackRule",
    }));
    expect(() => copied.wgslTurbopackRule()).toThrow(expect.objectContaining({
      code: "VGPU-WGSL-CACHE-IDENTITY",
      where: "wgslTurbopackRule",
      metadata: { path: join(root, "src/metadata.wgsl") },
    }));
  });
});

async function publishedFixture(label: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), `vgpu-inventory-${label}-`)));
  scratch.push(root);
  const helper = join(root, "dist/next/index.js");
  const loaderIndex = join(root, "dist/loader-webpack/index.js");
  const prepared = join(root, "dist/loader-webpack/prepared.js");
  const inventory = join(root, "dist/loader-shared/compiler-inventory.js");
  const anchor = join(root, "src/metadata.wgsl");
  const manifest = join(root, "package.json");
  await Promise.all([
    mkdir(join(root, "dist/next"), { recursive: true }),
    mkdir(join(root, "dist/loader-webpack"), { recursive: true }),
    mkdir(join(root, "dist/loader-shared"), { recursive: true }),
    mkdir(join(root, "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(helper, "export const helper = true;\n"),
    writeFile(loaderIndex, "export default function loader() {}\n"),
    writeFile(prepared, 'export { default } from "./index.js";\n'),
    writeFile(inventory, "export const inventory = true;\n"),
    writeFile(anchor, "// metadata anchor\n"),
    writeFile(manifest, manifestSource()),
  ]);
  return { root, helper, loaderIndex, prepared, anchor, manifest };
}

function manifestSource(version = "0.5.0", name = "@vgpu/wgsl"): string {
  return `${JSON.stringify({
    name,
    version,
    type: "module",
    exports: {
      "./_metadata.wgsl": "./src/metadata.wgsl",
      "./loader-webpack": {
        types: "./dist/loader-webpack/index.d.ts",
        import: "./dist/loader-webpack/prepared.js",
        require: "./dist/loader-webpack/prepared.js",
        default: "./dist/loader-webpack/prepared.js",
      },
    },
  })}\n`;
}
