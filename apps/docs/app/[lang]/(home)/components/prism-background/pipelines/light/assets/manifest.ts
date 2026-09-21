import type { LightAssetId, LightAssetSpec } from "./types";

export const WALL_GLOBAL_LIGHT_MASK_URL =
  "/hero/prism-light/wall-global-light-mask.webp";

export const LIGHT_ASSET_MANIFEST = {
  "wall-material": {
    id: "wall-material",
    size: [512, 512],
  },
  "wall-lighting": {
    id: "wall-lighting",
    size: [512, 512],
  },
  "caustic-profile": {
    id: "caustic-profile",
    size: [1024, 256],
  },
} as const satisfies Record<LightAssetId, LightAssetSpec>;

export const LIGHT_ASSET_IDS = Object.freeze(
  Object.keys(LIGHT_ASSET_MANIFEST) as LightAssetId[]
);
