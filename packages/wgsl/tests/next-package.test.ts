import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const execFile = promisify(execFileCallback);
const workspaceWgsl = resolve("packages/wgsl");
const workspaceWgslStd = resolve("packages/wgsl-std");
let fixture: Awaited<ReturnType<typeof createFixture>>;

beforeAll(async () => {
  fixture = await createFixture();
}, 60_000);

afterAll(async () => {
  await fixture?.dispose();
});

describe("published @vgpu/wgsl/next package", () => {
  test("packs the helper, wrapper, original loader and metadata anchor", async () => {
    const members = await tarMembers(fixture.wgslTarball);
    for (const member of [
      "package/dist/next/index.js",
      "package/dist/next/index.d.ts",
      "package/dist/loader-shared/compiler-inventory.js",
      "package/dist/loader-webpack/prepared.js",
      "package/dist/loader-webpack/index.js",
      "package/dist/loader-webpack/index.d.ts",
      "package/src/metadata.wgsl",
    ]) expect(members).toContain(member);

    const manifest = JSON.parse(await readFile(join(fixture.wgslRoot, "package.json"), "utf8"));
    expect(manifest.exports["./loader-webpack"]).toEqual({
      types: "./dist/loader-webpack/index.d.ts",
      import: "./dist/loader-webpack/prepared.js",
      require: "./dist/loader-webpack/prepared.js",
      default: "./dist/loader-webpack/prepared.js",
    });
    expect(manifest.exports["./next"]).toEqual({
      types: "./dist/next/index.d.ts",
      import: "./dist/next/index.js",
      require: "./dist/next/index.js",
      default: "./dist/next/index.js",
    });
    expect(manifest.vgpuExportBundleAudiences["./next"]).toBe("tooling");
    expect(manifest.vgpuExportBundleBudgetsGzipBytes["./next"]).toBeGreaterThan(0);
  });

  test("external Node 22 ESM and CommonJS load only public package specifiers", async () => {
    const esm = `
import * as root from "@vgpu/wgsl";
import { wgslTurbopackRule } from "@vgpu/wgsl/next";
import loader from "@vgpu/wgsl/loader-webpack";
import { fileURLToPath } from "node:url";
const rule = wgslTurbopackRule({ minify: true });
console.log(JSON.stringify({
  rule,
  loader: typeof loader,
  loaderResolved: fileURLToPath(import.meta.resolve("@vgpu/wgsl/loader-webpack")),
  rootHelper: "wgslTurbopackRule" in root,
}));
`;
    const cjs = `
const next = require("@vgpu/wgsl/next");
const loader = require("@vgpu/wgsl/loader-webpack");
console.log(JSON.stringify({
  rule: next.wgslTurbopackRule(),
  loader: typeof loader.default,
  nextResolved: require.resolve("@vgpu/wgsl/next"),
  loaderResolved: require.resolve("@vgpu/wgsl/loader-webpack"),
}));
`;
    const [{ stdout: esmOut }, { stdout: cjsOut }] = await Promise.all([
      execFile(process.execPath, ["--input-type=module", "--eval", esm], { cwd: fixture.consumer, encoding: "utf8" }),
      execFile(process.execPath, ["--input-type=commonjs", "--eval", cjs], { cwd: fixture.consumer, encoding: "utf8" }),
    ]);
    const esmResult = JSON.parse(esmOut);
    const cjsResult = JSON.parse(cjsOut);
    expect(esmResult.loader).toBe("function");
    expect(esmResult.rootHelper).toBe(false);
    expect(esmResult.rule.loaders[0].loader).toBe(join(fixture.wgslRoot, "dist/loader-webpack/prepared.js"));
    expect(esmResult.loaderResolved).toBe(join(fixture.wgslRoot, "dist/loader-webpack/prepared.js"));
    expect(cjsResult.loader).toBe("function");
    expect(cjsResult.rule.loaders[0].loader).toBe(join(fixture.wgslRoot, "dist/loader-webpack/prepared.js"));
    expect(cjsResult.nextResolved).toBe(join(fixture.wgslRoot, "dist/next/index.js"));
    expect(cjsResult.loaderResolved).toBe(join(fixture.wgslRoot, "dist/loader-webpack/prepared.js"));
  });

  test("the helper selects its own nested installation from another cwd", async () => {
    const nestedRoot = join(fixture.consumer, "node_modules/holder/node_modules/@vgpu/wgsl");
    const nestedStd = join(fixture.consumer, "node_modules/holder/node_modules/@vgpu/wgsl-std");
    await extractTarball(fixture.wgslTarball, nestedRoot);
    await extractTarball(fixture.stdTarball, nestedStd);
    const nestedEntry = join(fixture.consumer, "node_modules/holder/check.mjs");
    await writeFile(nestedEntry, `
import { wgslTurbopackRule } from "@vgpu/wgsl/next";
console.log(JSON.stringify(wgslTurbopackRule()));
`);
    const { stdout } = await execFile(process.execPath, [nestedEntry], { cwd: tmpdir(), encoding: "utf8" });
    const rule = JSON.parse(stdout);
    expect(rule.loaders[0].loader).toBe(join(nestedRoot, "dist/loader-webpack/prepared.js"));
    expect(rule.loaders[0].loader).not.toContain(workspaceWgsl);
  });

  test("the helper has no Next dependency or source-checkout dependency", async () => {
    const manifest = JSON.parse(await readFile(join(fixture.wgslRoot, "package.json"), "utf8"));
    const code = await readFile(join(fixture.wgslRoot, "dist/next/index.js"), "utf8");
    expect(manifest.dependencies).not.toHaveProperty("next");
    expect(manifest.peerDependencies).not.toHaveProperty("next");
    expect(code).not.toMatch(/(?:from|import\()\s*["']next/u);
    expect(code).not.toContain(workspaceWgsl);
    expect(await sha256(fixture.wgslTarball)).toMatch(/^[a-f0-9]{64}$/u);
  });

  test.each([
    ["Next 15.5", resolve("examples/next-wgsl/node_modules/next")],
    ["Next 16.3", resolve("apps/docs/node_modules/next")],
  ])("declarations compose with %s NextConfig types", async (_label, nextPath) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-next-types-")));
    try {
      const scope = join(root, "node_modules/@vgpu");
      await mkdir(scope, { recursive: true });
      await symlink(fixture.wgslRoot, join(scope, "wgsl"), "dir");
      await symlink(await realpath(nextPath), join(root, "node_modules/next"), "dir");
      await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
      await writeFile(join(root, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ["config.ts"],
      }, null, 2)}\n`);
      await writeFile(join(root, "config.ts"), TYPE_FIXTURE);
      await execFile(resolve("node_modules/.bin/tsc"), ["-p", join(root, "tsconfig.json"), "--pretty", "false"], {
        cwd: root,
        encoding: "utf8",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const TYPE_FIXTURE = `
import type { NextConfig } from "next";
import { wgslTurbopackRule } from "@vgpu/wgsl/next";

const extraRule = { loaders: [{ loader: "svg-loader", options: {} }], as: "*.js" as const };
const configs: NextConfig[] = [
  { turbopack: { rules: { "*.wgsl": wgslTurbopackRule(), "*.svg": extraRule } } },
  { turbopack: { rules: { "*.wgsl": wgslTurbopackRule({ minify: true }) } } },
  { turbopack: { rules: { "*.wgsl": wgslTurbopackRule({ minify: { whitespace: false, identifiers: "safe" } }) } } },
];
const phaseConfig = async (_phase: string): Promise<NextConfig> => configs[0];
const wrap = <T extends NextConfig>(config: T): T => config;
wrap(configs[1]);
void phaseConfig;
// @ts-expect-error identifiers are intentionally closed
wgslTurbopackRule({ minify: { identifiers: "all" } });
// @ts-expect-error the private fingerprint is never caller-configurable
wgslTurbopackRule({ vgpuImplementationFingerprint: "manual" });
`;

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-next-package-")));
  const archives = join(root, "archives");
  const consumer = join(root, "consumer");
  const wgslRoot = join(consumer, "node_modules/@vgpu/wgsl");
  const stdRoot = join(consumer, "node_modules/@vgpu/wgsl-std");
  await mkdir(archives, { recursive: true });
  await execFile("pnpm", ["--dir", workspaceWgsl, "pack", "--pack-destination", archives], { encoding: "utf8" });
  await execFile("pnpm", ["--dir", workspaceWgslStd, "pack", "--pack-destination", archives], { encoding: "utf8" });
  const files = await readdir(archives);
  const wgslTarball = join(archives, findTarball(files, /^vgpu-wgsl-\d/u));
  const stdTarball = join(archives, findTarball(files, /^vgpu-wgsl-std-\d/u));
  await extractTarball(wgslTarball, wgslRoot);
  await extractTarball(stdTarball, stdRoot);
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
  return { root, consumer, wgslRoot, wgslTarball, stdTarball, dispose: () => rm(root, { recursive: true, force: true }) };
}

async function extractTarball(tarball: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await execFile("tar", ["-xzf", tarball, "--strip-components=1", "-C", destination]);
}

async function tarMembers(tarball: string): Promise<string[]> {
  const { stdout } = await execFile("tar", ["-tzf", tarball], { encoding: "utf8" });
  return stdout.trim().split(/\r?\n/u);
}

function findTarball(files: readonly string[], pattern: RegExp): string {
  const file = files.find((item) => pattern.test(item) && item.endsWith(".tgz"));
  if (!file) throw new Error(`pnpm pack did not produce ${pattern}`);
  return file;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
