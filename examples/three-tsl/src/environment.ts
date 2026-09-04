import * as THREE from "three/webgpu";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
// CC0 Poly Haven HDRI packaged as a data URI by @pmndrs/assets.
import sunsetHdri from "@pmndrs/assets/hdri/sunset.exr.js";

/**
 * Dusk image-based lighting for the lava scene: a warm sunset HDRI drives
 * ambient light and reflections — the reference photos read as warm
 * overcast dusk, not blue moonlight. The backdrop stays pure black.
 */
export async function applyNightEnvironment(scene: THREE.Scene): Promise<void> {
  const texture = await new EXRLoader().loadAsync(sunsetHdri);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = texture;
  scene.environmentIntensity = 0.5;
  scene.background = new THREE.Color(0x000000);
}
