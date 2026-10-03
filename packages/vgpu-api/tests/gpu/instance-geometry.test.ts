import { prepareShader } from "@vgpu/wgsl/prepare";
import { describe, expect, test } from "vitest";
import { draw, frame, geometry, init, target, VGPUError } from "../../src/node.ts";
import { instanceGeometry } from "../../src/scene/instance-geometry.ts";
import { instances } from "../../src/scene/instances.ts";

const INSTANCED = `
struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex fn vs_main(
  @location(0) position: vec2f,
  @location(1) world0: vec4f,
  @location(2) world1: vec4f,
  @location(3) world2: vec4f,
  @location(4) world3: vec4f,
  @location(5) tint: vec3f,
  @location(6) signedCode: i32,
  @location(7) kind: u32,
) -> VertexOut {
  var out: VertexOut;
  let world = mat4x4f(world0, world1, world2, world3);
  out.position = world * vec4f(position, 0.0, 1.0);
  out.color = tint;
  if (signedCode < 0) { out.color.g += 0.5; }
  if (kind == 2u) { out.color.b += 0.5; }
  return out;
}

@fragment fn fs_main(input: VertexOut) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("instanceGeometry native GPU acceptance", () => {
  test("transforms and f32/i32/u32 attributes remain independent across mirrors, passes, shrinking, and zero count", async () => {
    const gpu = await init();
    try {
      const mesh = geometry(gpu, {
        buffers: [{
          data: new Float32Array([
            -0.22, -0.42, 0.22, -0.42, -0.22, 0.42,
            -0.22, 0.42, 0.22, -0.42, 0.22, 0.42,
          ]),
          attributes: { position: { format: "float32x2", location: 0 } },
        }],
      });
      const collection = instances({
        capacity: 2,
        attributes: { tint: "float32x3", signedCode: "sint32", kind: "uint32" },
      });
      const left = collection.add({ tint: [1, 0, 0], signedCode: -1, kind: 2 });
      const right = collection.add({ tint: [0, 1, 0], signedCode: 1, kind: 3 });
      collection.setWorld(left, rotatedScaled(-0.55));
      collection.setWorld(right, translated(0.55));

      const mirrorA = instanceGeometry(gpu, collection, { mesh });
      const mirrorB = instanceGeometry(gpu, collection, { mesh });
      expect(mirrorA.geometry.vertexBuffers.at(-1)).not.toBe(mirrorB.geometry.vertexBuffers.at(-1));
      expect(mirrorA.publish()).toBe(2);
      expect(mirrorB.publish()).toBe(2);

      const drawA = draw(gpu, { shader: prepareShader(INSTANCED), geometry: mirrorA.geometry, label: "instances-A" });
      const drawB = draw(gpu, { shader: prepareShader(INSTANCED), geometry: mirrorB.geometry, label: "instances-B" });
      const a = target(gpu, { size: [32, 16], format: "rgba8unorm" });
      const b = target(gpu, { size: [32, 16], format: "rgba8unorm" });
      frame(gpu, (current) => {
        current.pass({ target: a, clear: [0, 0, 0, 1] }, (pass) => pass.draw(drawA, { instances: 2 }));
        current.pass({ target: b, clear: [0, 0, 0, 1] }, (pass) => pass.draw(drawB, { instances: 2 }));
      });
      const initialA = await a.color.read({ mipLevel: 0, region: "all" });
      const initialB = await b.color.read({ mipLevel: 0, region: "all" });
      expect(initialA).toEqual(initialB);
      expect(pixelAt(initialA, 32, 7, 8)).toEqual([255, 128, 128, 255]);
      expect(pixelAt(initialA, 32, 25, 8)).toEqual([0, 255, 0, 255]);

      collection.set(left, { tint: [0, 0, 1], signedCode: 1, kind: 0 });
      expect(mirrorA.publish()).toBe(2);
      frame(gpu, (current) => {
        current.pass({ target: a, clear: [0, 0, 0, 1] }, (pass) => pass.draw(drawA, { instances: 2 }));
        current.pass({ target: b, clear: [0, 0, 0, 1] }, (pass) => pass.draw(drawB, { instances: 2 }));
      });
      expect(pixelAt(await a.color.read({ mipLevel: 0, region: "all" }), 32, 7, 8)).toEqual([0, 0, 255, 255]);
      expect(pixelAt(await b.color.read({ mipLevel: 0, region: "all" }), 32, 7, 8)).toEqual([255, 128, 128, 255]);

      collection.remove(left);
      expect(collection.idAt(0)).toBe(right);
      expect(mirrorA.publish()).toBe(1);
      frame(gpu, (current) => current.pass({ target: a, clear: [0, 0, 0, 1] }, (pass) => pass.draw(drawA, { instances: 1 })));
      const shrunk = await a.color.read({ mipLevel: 0, region: "all" });
      expect(pixelAt(shrunk, 32, 7, 8)).toEqual([0, 0, 0, 255]);
      expect(pixelAt(shrunk, 32, 25, 8)).toEqual([0, 255, 0, 255]);

      collection.remove(right);
      expect(mirrorA.publish()).toBe(0);
      frame(gpu, (current) => current.pass({ target: a, clear: [0, 0, 0, 1] }, (pass) => pass.draw(drawA, { instances: 0 })));
      expect(pixelAt(await a.color.read({ mipLevel: 0, region: "all" }), 32, 25, 8)).toEqual([0, 0, 0, 255]);
    } finally {
      gpu.dispose();
    }
  });

  test("destroyed base geometry is rejected before native buffer encoding", async () => {
    const gpu = await init();
    try {
      const mesh = geometry(gpu, { buffers: [{ data: new Float32Array(6), attributes: { position: { format: "float32x2", location: 0 } } }] });
      const collection = instances({ capacity: 0, attributes: { tint: "float32x3", signedCode: "sint32", kind: "uint32" } });
      const bridge = instanceGeometry(gpu, collection, { mesh });
      const drawable = draw(gpu, { shader: prepareShader(INSTANCED), geometry: bridge.geometry });
      const output = target(gpu, { size: [1, 1], format: "rgba8unorm" });
      drawable.compileSync(output);
      mesh.destroy();
      expect(errorOf(() => drawable.draw({ target: output, instances: 0 }))).toMatchObject({ code: "VGPU-INSTANCE-DESTROYED" });
    } finally {
      gpu.dispose();
    }
  });
});

function translated(x: number): readonly number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
}

function rotatedScaled(x: number): readonly number[] {
  return [0, 0.75, 0, 0, -1.25, 0, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
}

function pixelAt(pixels: Uint8Array, width: number, x: number, y: number): readonly number[] {
  const offset = 4 * (y * width + x);
  return [...pixels.slice(offset, offset + 4)];
}

function errorOf(run: () => unknown): VGPUError {
  try { run(); } catch (error) { if (error instanceof VGPUError) return error; throw error; }
  throw new Error("Expected a VGPUError");
}
