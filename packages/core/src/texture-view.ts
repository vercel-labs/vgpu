import { ValidationError } from "./errors.ts";
import { Texture } from "./texture.ts";

type TextureLike = Texture | GPUTexture;

export interface CubeViewOptions {
  /**
   * Must match the WGSL binding type:
   * false -> dimension "cube" and texture_cube<f32>
   * true -> dimension "2d-array" and texture_2d_array<f32>
   */
  readonly compat: boolean;
  readonly label?: string;
}

export interface LayerViewOptions {
  readonly mipLevel?: number;
  readonly format?: GPUTextureFormat;
  readonly aspect?: GPUTextureAspect;
  readonly label?: string;
}

export function cubeView(texture: TextureLike, opts: CubeViewOptions): GPUTextureView {
  if (typeof opts?.compat !== "boolean") {
    throw new ValidationError({
      code: "VGPU-CORE-INVALID-USAGE",
      message: "cubeView requires an explicit boolean compat option matching the WGSL binding type.",
      where: "cubeView",
    });
  }

  assertTextureDimension2D(texture, "cubeView");

  const layers = arrayLayerCount(texture);
  if (layers !== 6) {
    throw new ValidationError({
      code: "VGPU-CORE-INVALID-USAGE",
      message: `cubeView requires a texture with exactly 6 array layers; received ${layers}.`,
      where: "cubeView",
    });
  }

  return gpuTexture(texture).createView({
    ...(opts.label === undefined ? {} : { label: opts.label }),
    dimension: opts.compat ? "2d-array" : "cube",
    baseArrayLayer: 0,
    arrayLayerCount: 6,
  });
}

export function layerView(texture: TextureLike, layer: number, opts: LayerViewOptions = {}): GPUTextureView {
  assertTextureDimension2D(texture, "layerView");

  return gpuTexture(texture).createView({
    ...(opts.label === undefined ? {} : { label: opts.label }),
    dimension: "2d",
    baseArrayLayer: layer,
    arrayLayerCount: 1,
    ...(opts.mipLevel === undefined ? {} : { baseMipLevel: opts.mipLevel, mipLevelCount: 1 }),
    ...(opts.format === undefined ? {} : { format: opts.format }),
    ...(opts.aspect === undefined ? {} : { aspect: opts.aspect }),
  });
}

function gpuTexture(texture: TextureLike): GPUTexture {
  return texture instanceof Texture ? texture.gpu : texture;
}

function assertTextureDimension2D(texture: TextureLike, where: "cubeView" | "layerView"): void {
  const dimension = textureDimension(texture);
  if (dimension !== "2d") {
    throw new ValidationError({
      code: "VGPU-CORE-INVALID-USAGE",
      message: `${where} requires a texture with dimension "2d"; received ${dimension}.`,
      where,
    });
  }
}

function arrayLayerCount(texture: TextureLike): number {
  if (texture instanceof Texture) return texture.size[2] ?? 1;
  return texture.depthOrArrayLayers;
}

function textureDimension(texture: TextureLike): GPUTextureDimension {
  if (texture instanceof Texture) return texture.dimension;
  return texture.dimension;
}
