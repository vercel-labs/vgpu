import type { Texture, TextureOptions } from "@vgpu/core";
import type { Gpu } from "./kernel.ts";
import { liveKernel, ownResource } from "./live-kernel.ts";

export type { TextureOptions, TextureReadOptions, TextureShape, TextureUsageName } from "@vgpu/core";

/** Standalone sampled/storage texture owned by this gpu. */
export function texture(gpu: Gpu, opts: TextureOptions): Texture {
  const kernel = liveKernel(gpu, "texture");
  const created = kernel.device.createTexture(opts);
  return ownResource(kernel, created, (owned) => owned.destroy(), (cb) => { created.onDestroy(cb); });
}
