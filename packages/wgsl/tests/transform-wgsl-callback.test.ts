import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { transformWgsl } from "@vgpu/wgsl/loader-vite";

test("transformWgsl preserves signed exponent literals when minifying leaf shaders", async () => {
  for (const minify of [true, { identifiers: "none" as const }, { identifiers: "safe" as const }]) {
    const result = await transformWgsl({
      source: "fn repro() -> bool { return 1e-8 > 0.0 && 0x1p+8 > 0.0; }",
      id: "/tmp/repro.wgsl",
      minify,
    });

    expect(result.code).toContain("1e-8");
    expect(result.code).toContain("0x1p+8");
    expect(result.code).not.toContain("1e -8");
    expect(result.code).not.toContain("0x1p +8");
  }
});

test("transformWgsl calls onDependency for transitive shader dependencies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  const entry = join(dir, "main.wgsl");
  const imported = join(dir, "imported.wgsl");
  await writeFile(entry, "import { imported } from './imported.wgsl'; fn main(){imported();}");
  await writeFile(imported, "export fn imported(){}");
  const onDependency = vi.fn();

  await transformWgsl({ source: await readFile(entry, "utf8"), id: entry, onDependency });

  expect(onDependency).toHaveBeenCalledTimes(1);
  expect(onDependency.mock.calls.map(([dep]) => dep)).toEqual([imported]);
  expect(onDependency).not.toHaveBeenCalledWith(entry);
});

test("transformWgsl re-reads a mutated transitive .wgsl file on the second transform", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-transform-fresh-"));
  const entry = join(dir, "main.wgsl");
  const imported = join(dir, "imported.wgsl");
  const source = "import { imported_color } from './imported.wgsl'; fn main_color() -> vec4f { return imported_color(); }";
  await writeFile(entry, source);
  await writeFile(imported, "export fn imported_color() -> vec4f { return vec4f(0.1, 0.2, 0.3, 1.0); }");

  const first = await transformWgsl({ source, id: entry });
  await writeFile(imported, "export fn imported_color() -> vec4f { return vec4f(0.9, 0.8, 0.7, 1.0); }");
  const second = await transformWgsl({ source, id: entry });

  expect(second.code).not.toBe(first.code);
  expect(second.code).toContain("0.9, 0.8, 0.7, 1.0");
});
