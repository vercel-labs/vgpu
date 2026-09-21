import type { Texture } from "vgpu/core";

export type LightAssetId =
  | "wall-material"
  | "wall-lighting"
  | "caustic-profile";

export interface LightAssetSpec {
  readonly id: LightAssetId;
  readonly size: readonly [number, number];
}

export interface GeneratedLightAsset {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array<ArrayBuffer>;
}

export interface LightAssetTextures {
  readonly wallMaterial: Texture;
  readonly wallLighting: Texture;
  readonly causticProfile: Texture;
}
