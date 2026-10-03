import { describe, expect, it } from "vitest";
import { multiplyMatrices } from "vgpu/scene";

import { NEIGHBORHOOD_PICK } from "./city";
import { decodePick, encodePickId, PICK_SIZE, pickRadius, PickQueue, pickViewProjection } from "./picking";

function transform(matrix: ArrayLike<number>, point: readonly number[]): number[] {
  return [0, 1, 2, 3].map((row) => point.reduce((sum, value, column) => sum + matrix[column * 4 + row]! * value, 0));
}

function bytesWith(entries: readonly (readonly [x: number, y: number, id: number])[]): Uint8Array {
  const bytes = new Uint8Array(PICK_SIZE * PICK_SIZE * 4);
  for (const [x, y, id] of entries) bytes.set(encodePickId(id), (y * PICK_SIZE + x) * 4);
  return bytes;
}

describe("modular-city picking", () => {
  it("maps the device-pixel window around the pointer onto the pick target one to one", () => {
    // A projective view-projection (w varies with depth), like a perspective camera.
    const viewProjection = multiplyMatrices(
      [1.6, 0, 0, 0, 0, 2.4, 0, 0, 0, 0, -1.02, -1, 0, 0, -2.02, 0],
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.3, -0.2, -8, 1],
      new Float32Array(16)
    );
    const size = [800, 400] as const;
    const point = { x: 610, y: 95 };
    const pick = pickViewProjection(viewProjection, point, size);
    for (const world of [[0, 0, 0, 1], [1.5, -0.5, 2, 1], [-2, 1, -3, 1]]) {
      const clip = transform(viewProjection, world);
      const picked = transform(pick, world);
      const pixel = [((clip[0]! / clip[3]! + 1) * size[0]) / 2, ((1 - clip[1]! / clip[3]!) * size[1]) / 2];
      const texel = [((picked[0]! / picked[3]! + 1) * PICK_SIZE) / 2, ((1 - picked[1]! / picked[3]!) * PICK_SIZE) / 2];
      expect(picked[3]).toBeCloseTo(clip[3]!, 4);
      expect(picked[2]! / picked[3]!).toBeCloseTo(clip[2]! / clip[3]!, 5);
      expect(texel[0]).toBeCloseTo(pixel[0]! - point.x + PICK_SIZE / 2, 3);
      expect(texel[1]).toBeCloseTo(pixel[1]! - point.y + PICK_SIZE / 2, 3);
    }
  });

  it("decodes 32-bit application codes and takes the nearest hit within the radius", () => {
    const code = (NEIGHBORHOOD_PICK | 11) >>> 0;
    expect(decodePick(bytesWith([[16, 16, code]]), 2)).toBe(code);
    expect(decodePick(bytesWith([[16, 16, 0x00ab_cdef]]), 2)).toBe(0x00ab_cdef);
    expect(decodePick(bytesWith([[19, 16, 7], [16, 15, 9]]), 6)).toBe(9);
    expect(decodePick(bytesWith([[19, 16, 7]]), 2)).toBe(0);
    expect(decodePick(bytesWith([[19, 16, 7]]), 4)).toBe(7);
    expect(decodePick(bytesWith([]), 16)).toBe(0);
    expect(() => decodePick(new Uint8Array(16), 4)).toThrow(RangeError);
  });

  it("gives touch a fingertip-sized radius in device pixels", () => {
    expect(pickRadius("mouse", 1)).toBe(3);
    expect(pickRadius("mouse", 2)).toBe(6);
    expect(pickRadius("pen", 0.25)).toBe(1);
    expect(pickRadius("touch", 1)).toBe(12);
    expect(pickRadius("touch", 3)).toBe(PICK_SIZE / 2);
  });

  it("runs one readback at a time, lets the latest request win, and drops stale results", () => {
    const queue = new PickQueue();
    const hit = bytesWith([[16, 16, 42]]);
    expect(queue.begin()).toBeUndefined();

    const first = queue.request({ x: 10, y: 20 }, 3, 1);
    const encoded = queue.begin()!;
    expect(encoded).toMatchObject({ token: first, x: 10, y: 20, radius: 3, generation: 1 });
    expect(queue.begin()).toBeUndefined();

    // A newer tap while the first readback is in flight waits, and the first result is stale.
    const second = queue.request({ x: 30, y: 40 }, 3, 1);
    expect(queue.begin()).toBeUndefined();
    expect(queue.finish(encoded, hit, 1)).toBeUndefined();
    const next = queue.begin()!;
    expect(next.token).toBe(second);
    expect(queue.finish(next, hit, 1)).toBe(42);

    // A rebuild between encode and readback invalidates the result.
    queue.request({ x: 1, y: 1 }, 3, 1);
    const beforeRebuild = queue.begin()!;
    expect(queue.finish(beforeRebuild, hit, 2)).toBeUndefined();

    // A failed readback is abandoned so later requests still run.
    queue.request({ x: 2, y: 2 }, 3, 2);
    const failed = queue.begin()!;
    queue.abandon(failed);
    expect(queue.inFlight).toBeUndefined();
    queue.request({ x: 3, y: 3 }, 3, 2);
    const retry = queue.begin()!;
    expect(queue.finish(retry, hit, 2)).toBe(42);

    // Dispose drops pending and in-flight work and refuses new requests.
    queue.request({ x: 4, y: 4 }, 3, 2);
    const late = queue.begin()!;
    queue.request({ x: 5, y: 5 }, 3, 2);
    queue.dispose();
    expect(queue.pending).toBeUndefined();
    expect(queue.finish(late, hit, 2)).toBeUndefined();
    expect(queue.request({ x: 6, y: 6 }, 3, 2)).toBe(0);
    expect(queue.begin()).toBeUndefined();
  });
});
