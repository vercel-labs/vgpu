// Application-owned GPU picking. vgpu has no built-in picking: on request, one frame renders the
// published instance bridges into a small ID target through a pick camera whose projection maps
// the pixels around the pointer onto that target, then reads the target back once.

import { multiplyMatrices } from "vgpu/scene";

/** Side of the square pick target, in device pixels of the output. */
export const PICK_SIZE = 32;
export const PICK_FORMAT = "rgba8unorm" as const;

export interface PickPoint {
  /** Pointer position in output device pixels (origin top-left). */
  readonly x: number;
  readonly y: number;
}

export interface PickRequest extends PickPoint {
  readonly token: number;
  /** Search radius in pick texels (= output device pixels). */
  readonly radius: number;
  readonly generation: number;
}

/**
 * Pick view-projection: `viewProjection` followed by a clip-space scale and offset that maps the
 * PICK_SIZE×PICK_SIZE device-pixel window centered on `point` onto the whole pick target.
 */
export function pickViewProjection(
  viewProjection: ArrayLike<number>,
  point: PickPoint,
  outputSize: readonly [number, number],
  out: Float32Array = new Float32Array(16)
): Float32Array {
  const [width, height] = outputSize;
  const nx = (2 * point.x) / width - 1;
  const ny = 1 - (2 * point.y) / height;
  const hx = PICK_SIZE / width;
  const hy = PICK_SIZE / height;
  const window = [1 / hx, 0, 0, 0, 0, 1 / hy, 0, 0, 0, 0, 1, 0, -nx / hx, -ny / hy, 0, 1];
  return multiplyMatrices(window, viewProjection, out) as Float32Array;
}

export function encodePickId(id: number): [number, number, number, number] {
  return [id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, (id >>> 24) & 0xff];
}

/** Nearest non-zero ID to the target center within `radius` texels; 0 when nothing was hit. */
export function decodePick(bytes: Uint8Array, radius: number, size = PICK_SIZE): number {
  if (bytes.length < size * size * 4) throw new RangeError(`Pick readback has ${bytes.length} bytes`);
  const center = size / 2;
  let best = 0;
  let bestDistance = radius * radius;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const id = (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
      if (id === 0) continue;
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const distance = dx * dx + dy * dy;
      if (distance <= bestDistance) {
        if (distance === bestDistance && best !== 0) continue;
        best = id;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** Pointer radius in device pixels: touch gets a fingertip-sized window. */
export function pickRadius(pointerType: string, devicePixelRatio: number): number {
  const css = pointerType === "touch" ? 12 : 3;
  return Math.min(PICK_SIZE / 2, Math.max(1, css * devicePixelRatio));
}

/**
 * Pick request lifecycle: the latest request wins, at most one readback is in flight, and a
 * result is dropped when a newer request exists, the city was rebuilt, or the queue was disposed.
 */
export class PickQueue {
  #latest = 0;
  #pending: PickRequest | undefined;
  #inFlight: PickRequest | undefined;
  #disposed = false;

  get pending(): PickRequest | undefined {
    return this.#pending;
  }

  get inFlight(): PickRequest | undefined {
    return this.#inFlight;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  request(point: PickPoint, radius: number, generation: number): number {
    if (this.#disposed) return 0;
    const token = ++this.#latest;
    this.#pending = { x: point.x, y: point.y, radius, generation, token };
    return token;
  }

  /** The request to encode this frame, if any and if no readback is in flight. */
  begin(): PickRequest | undefined {
    if (this.#disposed || this.#inFlight || !this.#pending) return undefined;
    this.#inFlight = this.#pending;
    this.#pending = undefined;
    return this.#inFlight;
  }

  /** Decodes a finished readback; undefined when the result is stale. */
  finish(request: PickRequest, bytes: Uint8Array, generation: number): number | undefined {
    if (this.#inFlight === request) this.#inFlight = undefined;
    if (this.#disposed || request.token !== this.#latest || request.generation !== generation) return undefined;
    return decodePick(bytes, request.radius);
  }

  /** Releases a failed readback so later requests can run. */
  abandon(request: PickRequest): void {
    if (this.#inFlight === request) this.#inFlight = undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.#pending = undefined;
    this.#inFlight = undefined;
  }
}
