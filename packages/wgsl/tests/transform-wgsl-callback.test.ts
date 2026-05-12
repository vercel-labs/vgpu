import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { transformWgsl } from "@vgpu/wgsl/loader-vite";

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
