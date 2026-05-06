import { describe, expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

const validation = process.env.VGPU_DOCKER_TEST === "1";

describe("s3 §8 1-39", () => {
  test.skipIf(!validation)("34 validation maps module line", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "const A = 1u;\nconst B = 1u;\nconst C = 1u;\nconst D = 1u;\nfn main(){ let x: u32 = 1.0; }" } })).rejects.toMatchObject({ range: { file: "a.wgsl", start: { line: 5 } } }));
  test.skipIf(!validation)("35 validation handles emitted fallback", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "fn bad( {" } })).rejects.toMatchObject({ range: { file: "a.wgsl" }, code: "VGPU-WGSL-NAGA-UNKNOWN" }));
  test("36 validate false skips validation", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "fn bad( {" }, validate: false })).resolves.toHaveProperty("wgsl"));
});
