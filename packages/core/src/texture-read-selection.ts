import { ValidationError } from "./errors.ts";
import { textureUsageFlags } from "./gpu-constants.ts";
import type { TextureReadOptions } from "./types.ts";

/** Native extents: array layers stay fixed; volume depth shrinks with the mip. */
export function textureMipExtent(texture: Pick<GPUTexture, "width" | "height" | "depthOrArrayLayers" | "dimension">, mipLevel: number): [number, number, number] {
  const scale = 2 ** mipLevel;
  return [Math.max(1, Math.floor(texture.width / scale)), Math.max(1, Math.floor(texture.height / scale)),
    texture.dimension === "3d" ? Math.max(1, Math.floor(texture.depthOrArrayLayers / scale)) : texture.depthOrArrayLayers];
}

export function textureReadSelection(texture: GPUTexture, options: TextureReadOptions, where: string) {
  const fail = (message: string): never => { throw new ValidationError({ code: "VGPU-CORE-TEXTURE-READ-INVALID", where, message,
    fix: 'Select an allocated mip and an in-bounds region on a single-sample texture with usage "copy_src".' }); };
  if (!options || !Number.isSafeInteger(options.mipLevel) || options.mipLevel < 0 || options.mipLevel >= texture.mipLevelCount) fail("mipLevel must select an allocated mip using a nonnegative safe integer.");
  if (texture.sampleCount !== 1) fail("Texture readback requires sampleCount 1; resolve multisampled textures explicitly before reading.");
  if (!(texture.usage & textureUsageFlags(["copy_src"]))) fail('Texture readback requires explicit "copy_src" usage.');
  const extent = textureMipExtent(texture, options.mipLevel);
  const origin = options.region === "all" ? [0, 0, 0] : options.region?.origin;
  const size = options.region === "all" ? extent : options.region?.size;
  if (!Array.isArray(origin) || origin.length !== 3 || !Array.isArray(size) || size.length !== 3) fail('region must be "all" or contain origin and size triples.');
  for (let i = 0; i < 3; i++) {
    const start = origin![i]!; const length = size![i]!;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0 || start > extent[i]! || length > extent[i]! - start) fail(`Read region axis ${i} is outside mip ${options.mipLevel} extent [${extent}].`);
  }
  // Snapshot caller-owned arrays before any asynchronous work.
  return { mipLevel: options.mipLevel, origin: [...origin!] as [number, number, number], size: [...size!] as [number, number, number], extent };
}

/** Bound staging and host allocations before submitting any GPU work. */
export function validateReadAllocation(byteLength: number, maxBufferSize: number | undefined, where: string): void {
  // A portable host byte-length ceiling, independent of engine-specific TypedArray limits.
  const limit = Math.min(maxBufferSize ?? 0xffff_ffff, 0xffff_ffff);
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > limit) {
    throw new ValidationError({ code: "VGPU-CORE-TEXTURE-READ-INVALID", where,
      message: `Readback allocation of ${byteLength} bytes exceeds the supported limit (${limit}).`,
      fix: "Read a smaller region or a higher mip level." });
  }
}
