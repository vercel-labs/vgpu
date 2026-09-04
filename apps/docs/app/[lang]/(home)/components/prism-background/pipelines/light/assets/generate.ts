import { LIGHT_ASSET_MANIFEST } from "./manifest";
import { generateCausticProfile } from "./generate-caustic";
import { generateWallLighting, generateWallMaterial } from "./generate-wall";
import type { GeneratedLightAsset, LightAssetId } from "./types";

export {
  applyGlobalLightMask,
  globalLightMaskEdgeMax,
} from "./global-light-mask";

export function generateLightAsset(id: LightAssetId): GeneratedLightAsset {
  const size = LIGHT_ASSET_MANIFEST[id].size;
  if (id === "wall-material") return generateWallMaterial(size);
  if (id === "wall-lighting") return generateWallLighting(size);
  return generateCausticProfile(size);
}
