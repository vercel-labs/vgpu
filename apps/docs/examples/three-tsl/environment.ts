import * as THREE from "three/webgpu";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";

/**
 * CC0 Poly Haven sunset HDRI, served as a static asset rather than the inlined
 * data URI `@pmndrs/assets` ships. The standalone example can afford the data
 * URI; a docs route cannot — base64 in the route chunk costs ~147 KB gzip and
 * is attributed to the example's bundle budget, while a public asset is
 * fetched on demand and is not. Same trick the ML examples use for their
 * runtimes and model files.
 */
export const HDRI_URL = "/examples/three-tsl/sunset.exr";

/**
 * Dusk image-based lighting for the lava scene: a warm sunset HDRI drives
 * ambient light and reflections — the reference photos read as warm
 * overcast dusk, not blue moonlight. The backdrop stays pure black.
 */
export async function applyNightEnvironment(
  scene: THREE.Scene,
  source: string | THREE.Texture = HDRI_URL
): Promise<THREE.Texture> {
  // The thumbnail run decodes the same .exr off disk and passes the texture in;
  // the browser fetches it by URL.
  const texture =
    typeof source === "string" ? await new EXRLoader().loadAsync(source) : source;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = texture;
  scene.environmentIntensity = 0.5;
  scene.background = new THREE.Color(0x000000);
  return texture;
}
