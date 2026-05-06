import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

describe("s3 §8 1-39", () => {
  test("14 direct cycle prints path", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "import { b } from './b.wgsl'; export fn a(){b();}", "/b.wgsl": "import { a } from './a.wgsl'; export fn b(){a();}" }, validate: false })).rejects.toThrow(/a\.wgsl.*b\.wgsl.*a\.wgsl/));
  test("17 re-export cycle errors", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "export { b } from './b.wgsl';", "/b.wgsl": "export { a } from './a.wgsl';" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-EXP-REEXPORT-CYCLE" }));
});
