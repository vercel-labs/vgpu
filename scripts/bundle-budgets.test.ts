import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import {
  BUDGET_NOTE,
  DEFAULT_GROWTH_THRESHOLD,
  evaluateBudget,
  exportBudgetField,
  formatFailure,
  formatVerdictLine,
  isMeasuredTarballEntry,
  measuredTarballPayload,
  nextBudgetBytes,
  parseTarEntries,
  prohibitedExperienceInputs,
  retainedMetafileInputs,
  resolveExportAudience,
  resolvePackageAudience,
  resolveThreshold,
  softLimitBytes,
  stripBudgetMetadata,
  stripSourcesContent,
} from "./lib/bundle-budgets.mjs";

const script = fileURLToPath(new URL("./check-bundle-size.mjs", import.meta.url));

test("experience metafile exclusions inspect retained primitive inputs, not deleted factory modules", () => {
  expect(
    prohibitedExperienceInputs("effect-only", [
      "packages/vgpu-api/dist/effect.js",
      "packages/vgpu-api/dist/scene/geometry-src/mesh-box.js",
      "packages/vgpu-api/dist/timer.js",
      "packages/vgpu-api/dist/storage.js",
      "packages/vgpu-api/dist/scene/geometry-descriptor.js",
      "packages/vgpu-api/dist/query-ring.js",
    ]),
  ).toEqual([
    { category: "scene primitive mesh", input: "packages/vgpu-api/dist/scene/geometry-src/mesh-box.js" },
    { category: "timer", input: "packages/vgpu-api/dist/timer.js" },
    { category: "storage", input: "packages/vgpu-api/dist/storage.js" },
    { category: "geometry descriptor", input: "packages/vgpu-api/dist/scene/geometry-descriptor.js" },
    { category: "query ring", input: "packages/vgpu-api/dist/query-ring.js" },
  ]);
  expect(prohibitedExperienceInputs("triangle-low-level", ["packages/vgpu-api/dist/draw.js"])).toEqual([]);
  expect(prohibitedExperienceInputs("triangle-low-level", ["packages\\vgpu-api\\dist\\scene\\geometry-src\\mesh-box.js"])).toEqual([
    { category: "scene primitive mesh", input: "packages/vgpu-api/dist/scene/geometry-src/mesh-box.js" },
  ]);
  expect(prohibitedExperienceInputs("draw-recipe-box", [
    "packages/vgpu-api/dist/scene/geometry-src/mesh-box.js",
    "packages/vgpu-api/dist/scene/geometry-src/mesh-cache.js",
    "packages/vgpu-api/dist/scene/geometry-src/mesh-torus.js",
  ])).toEqual([
    { category: "non-box scene primitive mesh", input: "packages/vgpu-api/dist/scene/geometry-src/mesh-torus.js" },
  ]);
});

test("experience input lists use bytes retained in the output, not all scanned metafile inputs", () => {
  expect(retainedMetafileInputs({
    inputs: {
      "fixtures/effect-only.ts": { bytesInOutput: 121 },
      "src/effect.ts": { bytesInOutput: 97 },
      "src/scene/geometry-src/mesh-torus.ts": { bytesInOutput: 0 },
    },
  })).toEqual(["fixtures/effect-only.ts", "src/effect.ts"]);
});

test("a budget is the next strictly greater 512 B multiple", () => {
  expect(nextBudgetBytes(0)).toBe(512);
  expect(nextBudgetBytes(1)).toBe(512);
  expect(nextBudgetBytes(512)).toBe(1024);
  expect(nextBudgetBytes(688)).toBe(1024);
  expect(nextBudgetBytes(1023)).toBe(1024);
  expect(nextBudgetBytes(21753)).toBe(22016);
});

test("every derived budget stays 512 B aligned and is strictly above its measurement", () => {
  for (let measured = 0; measured < 4096; measured += 7) {
    const budget = nextBudgetBytes(measured);
    expect(budget % 512).toBe(0);
    expect(budget).toBeGreaterThan(measured);
    expect(budget - measured).toBeLessThanOrEqual(512);
  }
});

test("nextBudgetBytes rejects unmeasurable sizes", () => {
  expect(() => nextBudgetBytes(Infinity)).toThrow(/cannot derive a budget/);
  expect(() => nextBudgetBytes(-1)).toThrow(/cannot derive a budget/);
});

test("client budgets are a hard gate", () => {
  expect(evaluateBudget({ measuredBytes: 1024, budgetBytes: 1024, audience: "client" }).status).toBe("ok");
  const verdict = evaluateBudget({ measuredBytes: 1025, budgetBytes: 1024, audience: "client" });
  expect(verdict).toMatchObject({ status: "fail", soft: false, limitBytes: 1024, overBudgetBytes: 1, suggestedBudgetBytes: 1536 });
});

test("tooling budgets warn inside the growth threshold and fail past it", () => {
  const budgetBytes = 1000;
  expect(softLimitBytes(budgetBytes)).toBe(1050);
  expect(evaluateBudget({ measuredBytes: 1000, budgetBytes, audience: "tooling" }).status).toBe("ok");
  expect(evaluateBudget({ measuredBytes: 1001, budgetBytes, audience: "tooling" }).status).toBe("warn");
  expect(evaluateBudget({ measuredBytes: 1050, budgetBytes, audience: "tooling" }).status).toBe("warn");
  const failed = evaluateBudget({ measuredBytes: 1051, budgetBytes, audience: "tooling" });
  expect(failed).toMatchObject({ status: "fail", soft: true, limitBytes: 1050, overLimitBytes: 1 });
});

test("the growth threshold is configurable per package and by flag", () => {
  expect(evaluateBudget({ measuredBytes: 1100, budgetBytes: 1000, audience: "tooling", threshold: 0.1 }).status).toBe("warn");
  expect(evaluateBudget({ measuredBytes: 1101, budgetBytes: 1000, audience: "tooling", threshold: 0.1 }).status).toBe("fail");
  expect(evaluateBudget({ measuredBytes: 1001, budgetBytes: 1000, audience: "tooling", threshold: 0 }).status).toBe("fail");
  expect(resolveThreshold({ name: "x" })).toBe(DEFAULT_GROWTH_THRESHOLD);
  expect(resolveThreshold({ name: "x", vgpuBundleBudgetGrowthThreshold: 0.2 })).toBe(0.2);
  expect(resolveThreshold({ name: "x", vgpuBundleBudgetGrowthThreshold: 0.2 }, 0.01)).toBe(0.01);
  expect(() => resolveThreshold({ name: "x", vgpuBundleBudgetGrowthThreshold: "5%" })).toThrow(/non-negative number/);
});

test("a missing artifact never passes a budget", () => {
  const verdict = evaluateBudget({ measuredBytes: Infinity, budgetBytes: 1024, audience: "tooling" });
  expect(verdict.status).toBe("fail");
  expect(formatVerdictLine("@vgpu/gone", verdict)).toContain("missing artifact");
});

test("unclassified entries default to the hard client gate", () => {
  expect(resolvePackageAudience({ name: "@vgpu/core" })).toBe("client");
  expect(resolveExportAudience({ name: "@vgpu/wgsl" }, "./runtime")).toBe("client");
  expect(resolveExportAudience({ name: "@vgpu/wgsl", vgpuBundleAudience: "tooling" }, "./runtime")).toBe("tooling");
  expect(resolveExportAudience({ name: "@vgpu/wgsl", vgpuBundleAudience: "tooling", vgpuExportBundleAudiences: { ".": "client" } }, ".")).toBe("client");
  expect(() => resolvePackageAudience({ name: "@vgpu/core", vgpuBundleAudience: "server" })).toThrow(/unknown audience/);
});

test("failures name the budget field, the entry, both sizes and the update command", () => {
  const message = formatFailure({
    label: "@vgpu/wgsl",
    field: exportBudgetField("."),
    manifestPath: "packages/wgsl/package.json",
    verdict: evaluateBudget({ measuredBytes: 1600, budgetBytes: 1536, audience: "client" }),
  });
  expect(message).toContain("@vgpu/wgsl");
  expect(message).toContain('packages/wgsl/package.json -> vgpuExportBundleBudgetsGzipBytes["."]');
  expect(message).toContain("1600 B");
  expect(message).toContain("1536 B");
  expect(message).toContain("pnpm bundle-check --update");
  expect(message).toContain("2048 B");
});

test("tarball measurement drops *.docs.md and sourcemap sourcesContent", () => {
  expect(isMeasuredTarballEntry("package/src/buffer.docs.md")).toBe(false);
  expect(isMeasuredTarballEntry("package/README.md")).toBe(true);
  expect(isMeasuredTarballEntry("package/dist/index.js")).toBe(true);

  const map = { version: 3, sources: ["../src/index.ts"], sourcesContent: ["const enormous = 1;".repeat(500)], mappings: "AAAA" };
  const stripped = stripSourcesContent("package/dist/index.js.map", Buffer.from(JSON.stringify(map)));
  expect(JSON.parse(stripped.toString()).sourcesContent).toBeUndefined();
  expect(JSON.parse(stripped.toString()).mappings).toBe("AAAA");
  expect(stripSourcesContent("package/dist/index.js", Buffer.from("not a map")).toString()).toBe("not a map");
  expect(stripSourcesContent("package/dist/broken.js.map", Buffer.from("{oops")).toString()).toBe("{oops");
});

test("tarball measurement ignores the budget metadata it rewrites", () => {
  const manifest = { name: "@vgpu/core", version: "1.0.0", vgpuBundleAudience: "tooling", vgpuBundleBudgetGzipBytes: 32768, vgpuExportBundleBudgetNote: BUDGET_NOTE };
  const stripped = JSON.parse(stripBudgetMetadata("package/package.json", Buffer.from(JSON.stringify(manifest))).toString());
  expect(stripped).toEqual({ name: "@vgpu/core", version: "1.0.0" });
  const nested = Buffer.from(JSON.stringify(manifest));
  expect(stripBudgetMetadata("package/dist/package.json", nested)).toBe(nested);
});

test("the measured payload is the filtered, stripped, path-sorted file bytes", () => {
  const tarball = tar([
    { path: "package/dist/index.js", contents: Buffer.from("export const a = 1;") },
    { path: "package/src/index.docs.md", contents: Buffer.from("# docs\n".repeat(100)) },
    { path: "package/dist/index.js.map", contents: Buffer.from(JSON.stringify({ version: 3, sourcesContent: ["huge"], mappings: "AAAA" })) },
  ]);
  const entries = parseTarEntries(tarball);
  expect(entries.map((entry) => entry.path)).toEqual(["package/dist/index.js", "package/src/index.docs.md", "package/dist/index.js.map"]);
  const payload = measuredTarballPayload(entries).toString();
  expect(payload).toBe(`export const a = 1;${JSON.stringify({ version: 3, mappings: "AAAA" })}`);
  expect(payload).not.toContain("docs");
});

test("the tar reader resolves GNU long names", () => {
  const longPath = `package/dist/${"nested/".repeat(20)}index.js`;
  expect(longPath.length).toBeGreaterThan(100);
  const entries = parseTarEntries(
    tar([
      { path: "././@LongLink", type: "L", contents: Buffer.from(`${longPath}\0`) },
      { path: longPath.slice(0, 100), contents: Buffer.from("export const a = 1;") },
    ]),
  );
  expect(entries.map((entry) => entry.path)).toEqual([longPath]);
});

test("the tar reader resolves ustar prefix fields", () => {
  const entries = parseTarEntries(tar([{ path: "index.js", prefix: "package/dist", contents: Buffer.from("a") }]));
  expect(entries[0].path).toBe("package/dist/index.js");
});

test("the tar reader applies PAX path overrides, so filtering and stripping still see real paths", () => {
  const manifest = { name: "@vgpu/core", version: "1.0.0", vgpuBundleAudience: "tooling", vgpuBundleBudgetGzipBytes: 32768 };
  const buffer = tar([
    { path: "PaxHeaders.0/package.json", type: "x", contents: paxRecords({ path: "package/package.json" }) },
    { path: "truncated-name", contents: Buffer.from(JSON.stringify(manifest)) },
    { path: "PaxHeaders.0/docs", type: "x", contents: paxRecords({ path: "package/src/index.docs.md" }) },
    { path: "truncated-docs", contents: Buffer.from("# docs\n".repeat(100)) },
  ]);
  const entries = parseTarEntries(buffer);
  expect(entries.map((entry) => entry.path)).toEqual(["package/package.json", "package/src/index.docs.md"]);
  // The PAX path is what makes the docs file excludable and the manifest metadata strippable.
  const payload = measuredTarballPayload(entries).toString();
  expect(payload).not.toContain("docs");
  expect(payload).not.toContain("vgpuBundleBudgetGzipBytes");
  expect(JSON.parse(payload)).toEqual({ name: "@vgpu/core", version: "1.0.0" });
});

test("the tar reader honours PAX size overrides", () => {
  const contents = Buffer.from("export const a = 1;");
  const entries = parseTarEntries(
    tar([
      { path: "PaxHeaders.0/index.js", type: "x", contents: paxRecords({ size: `${contents.length}` }) },
      { path: "package/dist/index.js", contents, sizeField: `${(0).toString(8).padStart(11, "0")}\0` },
    ]),
  );
  expect(entries).toHaveLength(1);
  expect(entries[0].contents.toString()).toBe("export const a = 1;");
});

test("the tar reader fails closed instead of under-measuring", () => {
  const file = { path: "package/dist/index.js", contents: Buffer.from("export const a = 1;") };

  // A malformed size field used to yield NaN, an empty body and a silently truncated walk.
  expect(() => parseTarEntries(tar([{ ...file, sizeField: "not-octal!!!\0" }]))).toThrow(/malformed octal size field/);
  expect(() => parseTarEntries(tar([{ ...file, sizeField: "000000000098\0" }]))).toThrow(/malformed octal size field/);

  // A body larger than the archive used to be silently clipped.
  expect(() => parseTarEntries(tar([{ ...file, sizeField: `${(4096).toString(8).padStart(11, "0")}\0` }]))).toThrow(/truncated archive/);
  expect(() => parseTarEntries(tar([file]).subarray(0, 512))).toThrow(/truncated archive/);
  expect(() => parseTarEntries(tar([file], { terminate: false }))).toThrow(/missing its end-of-archive marker/);

  // Unknown entry types (and PAX globals that rewrite paths or sizes) must not be skipped quietly.
  expect(() => parseTarEntries(tar([{ path: "package/link", type: "K", contents: Buffer.from("x") }, file]))).toThrow(/unsupported tar entry type "K"/);
  expect(() => parseTarEntries(tar([{ path: "pax_global", type: "g", contents: paxRecords({ path: "package/elsewhere" }) }, file]))).toThrow(/global PAX header .* overrides "path"/);
  expect(() => parseTarEntries(tar([{ path: "PaxHeaders.0/x", type: "x", contents: Buffer.from("999 path=package/x\n") }, file]))).toThrow(/invalid length/);
  expect(() => parseTarEntries(tar([{ path: "PaxHeaders.0/x", type: "x", contents: Buffer.from("17 pathpackage/x\n") }, file]))).toThrow(/without "="/);
  expect(() => parseTarEntries(tar([{ path: "PaxHeaders.0/x", type: "x", contents: paxRecords({ size: "-1" }) }, file]))).toThrow(/malformed size record/);

  // An empty archive would measure zero bytes and pass every budget.
  expect(() => parseTarEntries(Buffer.alloc(1024))).toThrow(/no files/);
  expect(() => parseTarEntries(tar([{ path: "package/dist/", type: "5" }]))).toThrow(/no files/);

  // Trailing junk after the end-of-archive marker means the walk stopped early.
  expect(() => parseTarEntries(Buffer.concat([tar([file]), Buffer.from("junk")]))).toThrow(/data after its end-of-archive marker/);
  expect(() => parseTarEntries(Buffer.concat([tar([file], { terminate: false }), Buffer.alloc(512)]))).toThrow(/expected at least two 512 B zero blocks/);

  // Directory entries are still skipped, and real files after them are still measured.
  expect(parseTarEntries(tar([{ path: "package/dist/", type: "5" }, file])).map((entry) => entry.path)).toEqual([file.path]);
});

test("the tar reader accepts what pnpm pack actually produces", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-budgets-pack-"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "dist", "index.js"), "export const a = 1;\n//# sourceMappingURL=index.js.map\n");
  writeFileSync(join(root, "dist", "index.js.map"), JSON.stringify({ version: 3, sources: ["../src/index.ts"], sourcesContent: ["export const a = 1;".repeat(200)], mappings: "AAAA" }));
  writeFileSync(join(root, "src", "index.docs.md"), "# docs\n".repeat(200));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "pack-sample", version: "0.0.0", files: ["dist", "src/**/*.docs.md"], vgpuBundleAudience: "tooling", vgpuBundleBudgetGzipBytes: 1024 }, null, 2)}\n`,
  );
  const packed = spawnSync("pnpm", ["--dir", root, "pack", "--pack-destination", root], { encoding: "utf8" });
  expect(packed.status, packed.stderr).toBe(0);

  const entries = parseTarEntries(gunzipSync(readFileSync(join(root, "pack-sample-0.0.0.tgz"))));
  const paths = entries.map((entry) => entry.path);
  expect(paths).toContain("package/package.json");
  expect(paths).toContain("package/dist/index.js");
  expect(paths).toContain("package/dist/index.js.map");
  expect(paths).toContain("package/src/index.docs.md");
  for (const entry of entries) expect(entry.contents.length).toBeGreaterThan(0);

  const payload = measuredTarballPayload(entries).toString();
  expect(payload).toContain("export const a = 1;");
  expect(payload).not.toContain("# docs");
  expect(payload).not.toContain("sourcesContent");
  expect(payload).not.toContain("vgpuBundleBudgetGzipBytes");
});

test("bundle-check gates, warns and re-baselines a workspace", () => {
  const root = writeFixture();
  const manifest = join(root, "packages", "demo", "package.json");

  const measured = Number(/(\d+) B gzip/.exec(run(root).stdout)?.[1]);
  expect(measured).toBeGreaterThan(0);

  // tooling entry, 1 B over budget: warning, exit 0.
  patch(manifest, { vgpuExportBundleBudgetsGzipBytes: { ".": measured - 1 }, vgpuExportBundleAudiences: { ".": "tooling" } });
  const warned = run(root);
  expect(warned.status).toBe(0);
  expect(warned.stdout).toContain("WARN demo [tooling]");
  expect(warned.stdout).toContain("within the 5.0% tooling growth threshold");

  // tooling entry past the threshold: hard failure with an actionable message.
  patch(manifest, { vgpuExportBundleBudgetsGzipBytes: { ".": Math.floor(measured / 1.2) } });
  const toolingFail = run(root);
  expect(toolingFail.status).toBe(1);
  expect(toolingFail.stdout).toContain("FAIL demo [tooling]");
  expect(toolingFail.stderr).toContain("tooling soft limit");
  expect(toolingFail.stderr).toContain('vgpuExportBundleBudgetsGzipBytes["."]');
  expect(toolingFail.stderr).toContain("pnpm bundle-check --update");

  // same size, unclassified entry: default client gate fails on the first byte over budget.
  patch(manifest, { vgpuExportBundleBudgetsGzipBytes: { ".": measured - 1 }, vgpuExportBundleAudiences: undefined });
  const clientFail = run(root);
  expect(clientFail.status).toBe(1);
  expect(clientFail.stdout).toContain("FAIL demo [client]");
  expect(clientFail.stderr).toContain("hard client budget");

  // --update rewrites budgets to the convention and documents it, then the check is green.
  expect(run(root, "--update").status).toBe(0);
  const updated = JSON.parse(readFileSync(manifest, "utf8"));
  expect(updated.vgpuExportBundleBudgetsGzipBytes["."]).toBe(nextBudgetBytes(measured));
  expect(updated.vgpuExportBundleBudgetNote).toBe(BUDGET_NOTE);
  expect(run(root).status).toBe(0);
  expect(run(root, "--update").stdout).toContain("nothing to update");
});

test("bundle-check honours --threshold and rejects nonsense flags", () => {
  const root = writeFixture();
  const manifest = join(root, "packages", "demo", "package.json");
  const measured = Number(/(\d+) B gzip/.exec(run(root).stdout)?.[1]);
  patch(manifest, { vgpuExportBundleBudgetsGzipBytes: { ".": measured - 1 }, vgpuExportBundleAudiences: { ".": "tooling" } });
  expect(run(root, "--threshold=0%").status).toBe(1);
  expect(run(root, "--threshold=50%").status).toBe(0);
  const invalid = run(root, "--nope");
  expect(invalid.status).toBe(2);
  expect(invalid.stderr).toContain("Unknown argument --nope");
});

function writeFixture() {
  const root = mkdtempSync(join(tmpdir(), "bundle-budgets-"));
  const dist = join(root, "packages", "demo", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.js"), Array.from({ length: 200 }, (_, index) => `export const value${index} = "${index.toString(36).padStart(8, "0")}";`).join("\n"));
  writeFileSync(
    join(root, "packages", "demo", "package.json"),
    `${JSON.stringify({ name: "demo", version: "0.0.0", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }, vgpuExportBundleBudgetsGzipBytes: { ".": 1_000_000 } }, null, 2)}\n`,
  );
  return root;
}

function patch(manifestPath: string, fields: Record<string, unknown>) {
  const manifest = { ...JSON.parse(readFileSync(manifestPath, "utf8")), ...fields };
  for (const [key, value] of Object.entries(fields)) if (value === undefined) delete manifest[key];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

type TarBlock = { path: string; contents?: Buffer; type?: string; sizeField?: string; prefix?: string };

/** Minimal ustar writer, so the tar reader is exercised against real headers. */
function tarBlock({ path, contents = Buffer.alloc(0), type = "0", sizeField, prefix = "" }: TarBlock) {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  header.write("000644 \0", 100, 8, "utf8");
  header.write(sizeField ?? `${contents.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  header.write("        ", 148, 8, "utf8");
  header.write(type, 156, 1, "utf8");
  header.write("ustar\x0000", 257, 8, "utf8");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
  return Buffer.concat([header, contents, Buffer.alloc((512 - (contents.length % 512)) % 512)]);
}

function tar(files: TarBlock[], { terminate = true } = {}) {
  return Buffer.concat([...files.map(tarBlock), ...(terminate ? [Buffer.alloc(1024)] : [])]);
}

function paxRecords(records: Record<string, string>) {
  return Buffer.concat(
    Object.entries(records).map(([key, value]) => {
      const payload = ` ${key}=${value}\n`;
      const length = `${payload.length + 1}`.length + payload.length;
      return Buffer.from(`${length}${payload}`, "utf8");
    }),
  );
}
