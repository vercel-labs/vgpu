import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  resolveExportAudience,
  resolvePackageAudience,
  resolveThreshold,
  softLimitBytes,
  stripBudgetMetadata,
  stripSourcesContent,
} from "./lib/bundle-budgets.mjs";

const script = fileURLToPath(new URL("./check-bundle-size.mjs", import.meta.url));

test("a budget is the next 512 B multiple at least 512 B above measured", () => {
  expect(nextBudgetBytes(0)).toBe(512);
  expect(nextBudgetBytes(1)).toBe(1024);
  expect(nextBudgetBytes(512)).toBe(1024);
  expect(nextBudgetBytes(688)).toBe(1536);
  expect(nextBudgetBytes(1023)).toBe(1536);
  expect(nextBudgetBytes(21753)).toBe(22528);
});

test("every derived budget keeps at least 512 B of headroom and stays 512 B aligned", () => {
  for (let measured = 0; measured < 4096; measured += 7) {
    const budget = nextBudgetBytes(measured);
    expect(budget % 512).toBe(0);
    expect(budget - measured).toBeGreaterThanOrEqual(512);
    expect(budget - measured).toBeLessThan(1024 + 512);
  }
});

test("nextBudgetBytes rejects unmeasurable sizes", () => {
  expect(() => nextBudgetBytes(Infinity)).toThrow(/cannot derive a budget/);
  expect(() => nextBudgetBytes(-1)).toThrow(/cannot derive a budget/);
});

test("client budgets are a hard gate", () => {
  expect(evaluateBudget({ measuredBytes: 1024, budgetBytes: 1024, audience: "client" }).status).toBe("ok");
  const verdict = evaluateBudget({ measuredBytes: 1025, budgetBytes: 1024, audience: "client" });
  expect(verdict).toMatchObject({ status: "fail", soft: false, limitBytes: 1024, overBudgetBytes: 1, suggestedBudgetBytes: 2048 });
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
  expect(message).toContain("2560 B");
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

/** Minimal ustar writer, so the tar reader is exercised against real headers. */
function tar(files: { path: string; contents: Buffer }[]) {
  const blocks = files.map(({ path, contents }) => {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100, "utf8");
    header.write("000644 \0", 100, 8, "utf8");
    header.write(`${contents.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
    header.write("        ", 148, 8, "utf8");
    header.write("0", 156, 1, "utf8");
    header.write("ustar\x0000", 257, 8, "utf8");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    return Buffer.concat([header, contents, Buffer.alloc((512 - (contents.length % 512)) % 512)]);
  });
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
