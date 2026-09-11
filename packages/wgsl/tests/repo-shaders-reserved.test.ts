import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { reservedIdentifierDiagnosticsForSource } from "../src/runtime/reserved-identifiers.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".next", ".turbo", ".context", ".artifacts"]);
/** Fixture that is invalid on purpose — it drives the `vgpu check` diagnostic test. */
const INTENTIONALLY_INVALID = "packages/vgpu-api/tests/fixtures/reserved-word.wgsl";

async function wgslFiles(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) await wgslFiles(join(dir, entry.name), found);
      continue;
    }
    if (entry.name.endsWith(".wgsl")) found.push(join(dir, entry.name));
  }
  return found;
}

test("the repository sweep excludes ignored workspace and compiler artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-repo-shader-sweep-"));
  try {
    await writeFile(join(directory, "authored.wgsl"), "// authored source");
    for (const name of [".context", ".artifacts"]) {
      await mkdir(join(directory, name));
      await writeFile(join(directory, name, "temporary.wgsl"), "// generated dependency fixture");
    }
    expect((await wgslFiles(directory)).map((file) => relative(directory, file))).toEqual(["authored.wgsl"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("every WGSL file in the repository is free of reserved identifiers", async () => {
  const files = await wgslFiles(repoRoot);
  // Guards against the sweep silently walking nothing.
  expect(files.length).toBeGreaterThan(50);

  const offenders: string[] = [];
  for (const file of files) {
    const path = relative(repoRoot, file);
    if (path === INTENTIONALLY_INVALID) continue;
    for (const diagnostic of reservedIdentifierDiagnosticsForSource(path, await readFile(file, "utf8"))) {
      offenders.push(`${path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the intentionally invalid fixture is still detected", async () => {
  const source = await readFile(join(repoRoot, INTENTIONALLY_INVALID), "utf8");
  expect(reservedIdentifierDiagnosticsForSource(INTENTIONALLY_INVALID, source)).toHaveLength(1);
});
