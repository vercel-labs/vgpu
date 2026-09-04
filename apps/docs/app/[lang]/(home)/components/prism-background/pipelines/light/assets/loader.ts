import type { Gpu } from "vgpu";
import type { Texture } from "vgpu/core";

import { bakeLightAssetTextures } from "./bake";
import { LIGHT_ASSET_IDS, LIGHT_ASSET_MANIFEST } from "./manifest";
import { generateMipChain } from "./mips";
import type {
  GeneratedLightAsset,
  LightAssetId,
  LightAssetSpec,
  LightAssetTextures,
} from "./types";

export interface LightTextureLoader {
  load(gpu: Gpu, spec: LightAssetSpec): Promise<Texture>;
}

export interface LightTextureLoaderOptions {
  readonly fallback?: (
    id: LightAssetId
  ) => GeneratedLightAsset | Promise<GeneratedLightAsset>;
}

/** CPU recovery path retained for devices that reject the one-time GPU bake. */
export function createLightTextureLoader(
  options: LightTextureLoaderOptions = {}
): LightTextureLoader {
  return {
    async load(gpu, spec) {
      const generated = options.fallback
        ? await options.fallback(spec.id)
        : (await import("./generate")).generateLightAsset(spec.id);
      const levels = generateMipChain(generated);
      return upload(gpu, spec.id, levels);
    },
  };
}

export async function loadLightAssetTextures(
  gpu: Gpu,
  loader?: LightTextureLoader
): Promise<LightAssetTextures> {
  if (!loader) {
    try {
      return await bakeLightAssetTextures(gpu);
    } catch {
      return loadLightAssetTextures(gpu, createLightTextureLoader());
    }
  }
  const settled = await Promise.allSettled(
    LIGHT_ASSET_IDS.map((id) => loader.load(gpu, LIGHT_ASSET_MANIFEST[id]))
  );
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failure) {
    for (const result of settled) {
      if (result.status === "fulfilled") result.value.destroy();
    }
    throw failure.reason;
  }
  const loaded = settled.map(
    (result) => (result as PromiseFulfilledResult<Texture>).value
  );
  return {
    wallMaterial: loaded[0]!,
    wallLighting: loaded[1]!,
    causticProfile: loaded[2]!,
  };
}

function upload(
  gpu: Gpu,
  id: LightAssetId,
  levels: readonly GeneratedLightAsset[]
): Texture {
  const base = levels[0]!;
  const texture = gpu.device.createTexture({
    size: [base.width, base.height],
    format: "rgba8unorm",
    mipLevelCount: levels.length,
    usage: ["texture_binding", "copy_dst"],
    label: `prism.light.${id}`,
  });
  try {
    levels.forEach((level, mipLevel) => {
      gpu.gpu.queue.writeTexture(
        { texture: texture.gpu, mipLevel },
        level.pixels,
        { bytesPerRow: level.width * 4, rowsPerImage: level.height },
        [level.width, level.height, 1]
      );
    });
  } catch (error) {
    texture.destroy();
    throw error;
  }
  return texture;
}

export function destroyLightAssetTextures(
  textures: LightAssetTextures | undefined
): void {
  if (!textures) return;
  textures.wallMaterial.destroy();
  textures.wallLighting.destroy();
  textures.causticProfile.destroy();
}
