import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveShader, type ResolveOptions } from "@vgpu/wgsl/runtime";

const ENTRY_SOURCE = (specifier: string) =>
  `import { watched } from '${specifier}'; fn main() { watched(); }`;
const DEPENDENCY_SOURCE = "export fn watched() {}";

test.each([
  { label: "explicit relative", specifier: "./shared.wgsl", index: false },
  { label: "extensionless relative index", specifier: "./shared", index: true },
])("watches a deleted $label dependency and resolves after recreation", async ({ specifier, index }) => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-missing-relative-"));
  const entry = join(dir, "main.wgsl");
  const unresolved = join(dir, "shared");
  const restored = index ? join(unresolved, "index.wgsl") : join(dir, "shared.wgsl");
  const expectedMissing = [restored];
  await writeFile(entry, ENTRY_SOURCE(specifier));
  if (index) await mkdir(unresolved);
  await writeFile(restored, DEPENDENCY_SOURCE);
  const initialDependencies: string[] = [];
  await resolveShader({
    entry,
    validate: false,
    onDependency(path) { initialDependencies.push(path); },
  });
  expect(initialDependencies).toEqual([restored]);
  await unlink(restored);
  const events: string[] = [];

  const failure = resolveShader({
    entry,
    validate: false,
    onDependency(path) { events.push(path); },
  }).catch((error: unknown) => {
    events.push("error");
    throw error;
  });

  await expect(failure).rejects.toMatchObject({
    code: "VGPU-WGSL-RES-NOTFOUND",
    message: `WGSL module ${restored} was not found`,
  });
  expect(events).toEqual([...expectedMissing, "error"]);

  await writeFile(restored, DEPENDENCY_SOURCE);
  const restoredDependencies: string[] = [];
  await expect(resolveShader({
    entry,
    validate: false,
    onDependency(path) { restoredDependencies.push(path); },
  })).resolves.toMatchObject({ deps: expect.arrayContaining([restored]) });
  expect(restoredDependencies).toEqual([restored]);
});

test.each([
  {
    label: "root",
    specifier: "@/shared",
    options(root: string): Partial<ResolveOptions> { return { rootDir: root }; },
  },
  {
    label: "mapped",
    specifier: "#lib/shared",
    options(root: string): Partial<ResolveOptions> { return { packageMap: { "#lib/": root } }; },
  },
])("reports missing $label alias candidates", async ({ specifier, options }) => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-missing-alias-"));
  const entry = join(dir, "main.wgsl");
  const aliasRoot = join(dir, "alias-root");
  const target = join(aliasRoot, "shared.wgsl");
  await mkdir(aliasRoot);
  await writeFile(entry, ENTRY_SOURCE(specifier));
  const dependencies: string[] = [];

  await expect(resolveShader({
    entry,
    validate: false,
    ...options(aliasRoot),
    onDependency(path) { dependencies.push(path); },
  })).rejects.toMatchObject({ code: "VGPU-WGSL-RES-NOTFOUND" });

  expect(dependencies).toEqual([target, join(aliasRoot, "shared", "index.wgsl")]);
});

test("reports a missing target from an existing package exports map and resolves after restoration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-missing-package-"));
  const entryDir = join(dir, "shaders");
  const packageDir = join(dir, "node_modules", "@acme", "shaders");
  const target = join(packageDir, "src", "shared.wgsl");
  const entry = join(entryDir, "main.wgsl");
  await mkdir(entryDir, { recursive: true });
  await mkdir(join(packageDir, "src"), { recursive: true });
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    name: "@acme/shaders",
    exports: { "./shared": "./src/shared.wgsl" },
  }));
  await writeFile(entry, ENTRY_SOURCE("@acme/shaders/shared"));
  const missingDependencies: string[] = [];

  await expect(resolveShader({
    entry,
    validate: false,
    onDependency(path) { missingDependencies.push(path); },
  })).rejects.toMatchObject({
    code: "VGPU-WGSL-RES-NOTFOUND",
    message: `WGSL module ${target} was not found`,
  });
  expect(missingDependencies).toEqual([target]);

  await writeFile(target, DEPENDENCY_SOURCE);
  const restoredDependencies: string[] = [];
  await expect(resolveShader({
    entry,
    validate: false,
    onDependency(path) { restoredDependencies.push(path); },
  })).resolves.toMatchObject({ deps: expect.arrayContaining([target]) });
  expect(restoredDependencies).toEqual([target]);
});

test("does not report synthetic candidates for missing virtual modules", async () => {
  const dependencies: string[] = [];

  await expect(resolveShader({
    entry: "/main.wgsl",
    modules: { "/main.wgsl": ENTRY_SOURCE("./shared") },
    validate: false,
    onDependency(path) { dependencies.push(path); },
  })).rejects.toMatchObject({ code: "VGPU-WGSL-RES-NOTFOUND" });

  expect(dependencies).toEqual([]);
});

test("keeps successful dependency notification order and deduplication unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-dependency-order-"));
  const entry = join(dir, "main.wgsl");
  const first = join(dir, "first.wgsl");
  const second = join(dir, "second.wgsl");
  const shared = join(dir, "shared.wgsl");
  await writeFile(entry, "import { first } from './first'; import { second } from './second'; fn main() { first(); second(); }");
  await writeFile(first, "import { watched } from './shared'; export fn first() { watched(); }");
  await writeFile(second, "import { watched } from './shared'; export fn second() { watched(); }");
  await writeFile(shared, DEPENDENCY_SOURCE);
  const dependencies: string[] = [];

  await resolveShader({
    entry,
    validate: false,
    onDependency(path) { dependencies.push(path); },
  });

  expect(dependencies).toEqual([first, shared, second]);
});
