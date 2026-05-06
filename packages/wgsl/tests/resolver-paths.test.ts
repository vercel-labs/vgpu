import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

describe("s3 §8 1-39", () => {
  test("18 root alias resolves against rootDir", async () => expect((await resolveShader({ entry: "/main.wgsl", rootDir: "/src", modules: { "/main.wgsl": "import { x } from '@/x'; fn main(){x();}", "/src/x.wgsl": "export fn x(){}" }, validate: false })).wgsl).toContain("/src/x.wgsl"));
  test("19 relative extension and index resolution", async () => { const dir = await mkdtemp(join(tmpdir(), "vgsl-")); await mkdir(join(dir, "foo")); await writeFile(join(dir, "main.wgsl"), "import { x } from './foo'; fn main(){x();}"); await writeFile(join(dir, "foo", "index.wgsl"), "export fn x(){}"); expect((await resolveShader({ entry: join(dir, "main.wgsl"), validate: false })).wgsl).toContain("index.wgsl"); });
  test("20 missing file errors", async () => await expect(resolveShader({ entry: "/missing.wgsl", modules: {}, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-RES-NOTFOUND" }));
});
