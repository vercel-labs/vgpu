import { describe, expect, test } from "vitest";
import { compile } from "@vgpu/wgsl";
import { resolveShader } from "@vgpu/wgsl/runtime";

describe("s3 §8 1-39", () => {
  test("6 non-exported import errors", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x } from './a.wgsl'; fn main(){x();}", "/a.wgsl": "fn x(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-SYM-NOEXPORT" }));
  test("7 import alias rebinds use sites", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x as y } from './a.wgsl'; fn main(){y();}", "/a.wgsl": "export fn x(){}" }, validate: false })).wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__main\(\)\{_vgsl_[0-9a-f]{8}__x\(\);\}/));
  test("10 conflicting imports error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { a as x } from './a.wgsl'; import { b as x } from './b.wgsl';", "/a.wgsl": "export fn a(){}", "/b.wgsl": "export fn b(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-SYM-IMPORT-SHADOW" }));
  test("11 default import errors", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import x from './a.wgsl';", "/a.wgsl": "" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-IMP-DEFAULT" }));
  test("12 side-effect import errors", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import './a.wgsl';", "/a.wgsl": "" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-IMP-SIDEEFFECT" }));
  test("13 imports after declarations error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "fn f(){} import { x } from './a.wgsl';", "/a.wgsl": "export fn x(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-IMP-ORDER" }));
  test("15 self import errors", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "import { a } from './a.wgsl'; export fn a(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-IMP-SELF" }));
  test("21 absolute imports error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x } from '/x.wgsl';" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-RES-ABS" }));
});

describe("s3", () => {
  test("75: comment-only import treated as plain WGSL", () => {
    const source = "// import { x } from './x.wgsl'\n@compute @workgroup_size(1) fn main() {}";
    expect(compile(source).wgsl).toBe(source);
  });
});
