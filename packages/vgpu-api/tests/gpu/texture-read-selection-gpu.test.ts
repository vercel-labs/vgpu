import { describe, expect, test } from "vitest";
import { compute, effect, frame, init, target, texture } from "../../src/node.ts";

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("explicit mip/region readback on Dawn", () => {
  test.each(["2d-array", "3d"] as const)("%s upload/read isolates mip copying from shader writes", async kind => {
    const gpu = await init();
    try {
      const shape = kind === "3d" ? { kind, size: [7, 5, 5] as const } : { kind, size: [7, 5] as const, layers: 3 };
      const tex = texture(gpu, { ...shape, format: "rgba32float", mipLevelCount: 3, usage: ["copy_src", "copy_dst"] });
      for (let mip = 0; mip < 3; mip++) {
        const w = Math.max(1, Math.floor(7 / 2 ** mip)); const h = Math.max(1, Math.floor(5 / 2 ** mip));
        const d = kind === "3d" ? Math.max(1, Math.floor(5 / 2 ** mip)) : 3;
        const expected = Float32Array.from({ length: w * h * d * 4 }, (_, i) => i + mip * 1000 - 3.5);
        gpu.device.gpu.queue.writeTexture({ texture: tex.gpu, mipLevel: mip }, expected, { bytesPerRow: w * 16, rowsPerImage: h }, [w, h, d]);
        expect(await tex.readFloats({ mipLevel: mip, region: "all" })).toEqual(expected);
      }
    } finally { gpu.dispose(); }
  });
  // Keep the restricted-view variant: Dawn's OpenGL backend currently fails this valid sequence,
  // also reproducible with raw WebGPU. Full-chain sampling independently verifies the read contract.
  test.each((["2d", "2d-array", "3d"] as const).flatMap(kind => [true, false].map(restricted => ({ kind, restricted }))))("$kind compute/read/sample, restricted sampling view=$restricted", async ({ kind, restricted }) => {
    const gpu = await init();
    gpu.device.gpu.pushErrorScope("validation");
    try {
      const shape = kind === "3d" ? { kind, size: [7, 5, 5] as const } : kind === "2d-array" ? { kind, size: [7, 5] as const, layers: 3 } : { kind, size: [7, 5] as const };
      const tex = texture(gpu, { ...shape, format: "rgba16float", mipLevelCount: 3, usage: ["storage_binding", "texture_binding", "copy_src"] });
      const dimension = kind.replaceAll("-", "_");
      const coords = kind === "3d" ? "id" : kind === "2d-array" ? "id.xy, id.z" : "id.xy";
      for (let mip = 0; mip < 3; mip++) {
        const w = Math.max(1, Math.floor(7 / 2 ** mip)); const h = Math.max(1, Math.floor(5 / 2 ** mip));
        const d = kind === "3d" ? Math.max(1, Math.floor(5 / 2 ** mip)) : kind === "2d-array" ? 3 : 1;
        const view = tex.createView({ dimension: kind, baseMipLevel: mip, mipLevelCount: 1 });
        compute(gpu, `
          @group(0) @binding(0) var image: texture_storage_${dimension}<rgba16float, write>;
          @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id: vec3u) {
            textureStore(image, ${coords}, vec4f(f32(id.x) + ${mip}.5, f32(id.y) - 2.0, f32(id.z) * 7.0, 1.0));
          }
        `, { set: { image: view } }).dispatch(w, h, d);
        const expected: number[] = [];
        for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expected.push(x + mip + .5, y - 2, z * 7, 1);
        expect(await tex.readFloats({ mipLevel: mip, region: "all" })).toEqual(new Float32Array(expected));
        const origin = [w > 1 ? 1 : 0, h > 1 ? 1 : 0, d > 1 ? 1 : 0] as const;
        const crop: number[] = [];
        for (let z = origin[2]; z < d; z++) for (let y = origin[1]; y < h; y++) for (let x = origin[0]; x < w; x++) crop.push(x + mip + .5, y - 2, z * 7, 1);
        expect(await tex.readFloats({ mipLevel: mip, region: { origin, size: [w - origin[0], h - origin[1], d - origin[2]] } })).toEqual(new Float32Array(crop));

        const output = target(gpu, { size: [w, h], format: "rgba32float" });
        const sampleCoords = kind === "3d" ? `vec3i(vec2i(p.xy), ${d - 1})` : kind === "2d-array" ? `vec2i(p.xy), ${d - 1}` : "vec2i(p.xy)";
        const sample = effect(gpu, `
          @group(0) @binding(0) var image: texture_${dimension}<f32>;
          @fragment fn main(@builtin(position) p: vec4f) -> @location(0) vec4f {
            return textureLoad(image, ${sampleCoords}, ${restricted ? 0 : mip});
          }
        `, { set: { image: restricted ? view : tex.createView({ dimension: kind }) } });
        frame(gpu, f => f.pass({ target: output }, p => p.draw(sample)));
        expect((await gpu.device.gpu.popErrorScope())?.message).toBeUndefined();
        gpu.device.gpu.pushErrorScope("validation");
        expect(await output.color.readFloats({ mipLevel: 0, region: "all" })).toEqual(new Float32Array(expected.slice((d - 1) * w * h * 4)));
      }
      expect((await tex.readFloats({ mipLevel: 0, region: "all" }))[0]).toBe(.5);
      expect(await gpu.device.gpu.popErrorScope()).toBeNull();
    } finally { gpu.dispose(); }
  });
});
