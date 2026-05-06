import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

const validation = process.env.VGPU_DOCKER_TEST === "1";

test.skipIf(!validation)("validation maps module line", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "const A = 1u;\nconst B = 1u;\nconst C = 1u;\nconst D = 1u;\nfn main(){ let x: u32 = 1.0; }" } })).rejects.toMatchObject({ range: { file: "a.wgsl", start: { line: 5 } } }));
test.skipIf(!validation)("validation handles emitted fallback", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "fn bad( {" } })).rejects.toMatchObject({ range: { file: "a.wgsl" }, code: "VGPU-WGSL-NAGA-UNKNOWN" }));
test("validate false skips validation", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "fn bad( {" }, validate: false })).resolves.toHaveProperty("wgsl"));
test.skipIf(!validation)("approximate diagnostic tagged", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { f } from './f.wgsl'; fn main(){ let x: u32 = f(); }", "/f.wgsl": "export fn f() -> f32 { return 1.0; }" } })).rejects.toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN", columnPrecise: false, relatedDiagnostics: [expect.objectContaining({ code: "VGPU-WGSL-COL-APPROX" })] }));
test.skipIf(!validation)("precise diagnostic before substitution", async () => { try { await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "@compute @workgroup_size(1) fn main(){ let x: u32 = 1.0; }" } }); throw new Error("expected validation failure"); } catch (error) { expect(error).toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN", range: { file: "m.wgsl" }, columnPrecise: true }); expect(JSON.stringify(error)).not.toContain("VGPU-WGSL-COL-APPROX"); } });
