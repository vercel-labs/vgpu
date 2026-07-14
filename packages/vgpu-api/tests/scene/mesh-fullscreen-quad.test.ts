import { init } from "../../src/mock.ts";
import { Mesh } from "../../src/scene/geometry-src/index.ts";
import { expect, test } from "vitest";

test("Mesh.fullscreenQuad creates a position-only clip-space quad", async () => {
  const { device } = await init();

  const mesh = Mesh.fullscreenQuad({ device });
  expect(mesh.vertexCount).toBe(6);
  expect(mesh.layout).toBe("position-only");
  expect(mesh.attributes).toEqual({ stride: 12, position: { offset: 0, format: "float32x3" } });
  expect(mesh.indexBuffer).toBeUndefined();
  expect(mesh.indexCount).toBeUndefined();
  expect(mesh.indexFormat).toBeUndefined();
  expect(mesh.gpu).toEqual({ vertexBuffer: mesh.vertexBuffer.gpu });

  const floats = new Float32Array(await mesh.vertexBuffer.read(6 * 3 * 4));
  expect(Array.from(floats)).toEqual([
    -1, -1, 0,
    1, -1, 0,
    -1, 1, 0,
    1, -1, 0,
    1, 1, 0,
    -1, 1, 0,
  ]);
  expect(new Set(chunks(floats))).toEqual(new Set(["-1,-1,0", "1,-1,0", "-1,1,0", "1,1,0"]));

  device.destroy();
});

test("Mesh.fullscreenQuad caches per device", async () => {
  const first = await init();
  const second = await init();

  expect(Mesh.fullscreenQuad({ device: first.device })).toBe(Mesh.fullscreenQuad({ device: first.device }));
  expect(Mesh.fullscreenQuad({ device: first.device })).not.toBe(Mesh.fullscreenQuad({ device: second.device }));

  first.device.destroy();
  second.device.destroy();
});

function chunks(floats: Float32Array): string[] {
  const out: string[] = [];
  for (let i = 0; i < floats.length; i += 3) out.push(`${floats[i]!},${floats[i + 1]!},${floats[i + 2]!}`);
  return out;
}
