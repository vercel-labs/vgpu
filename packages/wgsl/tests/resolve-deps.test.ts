import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

test("resolveShader deps include entry and transitive imports sorted and deduped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  await mkdir(join(dir, "shaders"));
  const entry = join(dir, "shaders", "main.wgsl");
  const a = join(dir, "shaders", "a.wgsl");
  const b = join(dir, "shaders", "b.wgsl");
  const shared = join(dir, "shaders", "shared.wgsl");
  await writeFile(entry, "import { b } from './b.wgsl'; import { a } from './a.wgsl'; fn main(){a();b();}");
  await writeFile(a, "import { shared } from './shared.wgsl'; export fn a(){shared();}");
  await writeFile(b, "import { shared } from './shared.wgsl'; export fn b(){shared();}");
  await writeFile(shared, "export fn shared(){}");

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps).toEqual([a, b, entry, shared].sort());
});

test("resolveShader deps contain only the entry for a leaf shader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-"));
  const entry = join(dir, "leaf.wgsl");
  await writeFile(entry, "fn main(){}");

  const result = await resolveShader({ entry, validate: false });

  expect(result.deps).toEqual([entry]);
});
