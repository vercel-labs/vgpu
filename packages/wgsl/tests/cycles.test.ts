import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

test("direct cycle reports the import path", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "import { b } from './b.wgsl'; export fn a(){b();}", "/b.wgsl": "import { a } from './a.wgsl'; export fn b(){a();}" }, validate: false })).rejects.toThrow(/a\.wgsl.*b\.wgsl.*a\.wgsl/));
test("re-export cycles error", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "export { b } from './b.wgsl';", "/b.wgsl": "export { a } from './a.wgsl';" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-EXP-REEXPORT-CYCLE" }));
