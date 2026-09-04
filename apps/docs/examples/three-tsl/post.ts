import * as THREE from "three/webgpu";
import { pass } from "three/tsl";

/**
 * Offscreen-only output pipeline. Rendering directly into a RenderTarget
 * treats it as a linear intermediate, so deterministic screenshots use this
 * scene pass to apply the renderer's tone mapping and output transform. The
 * interactive scene renders straight to its canvas and does not use it.
 */
export function createOutputPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { readonly samples?: number } = {},
): THREE.PostProcessing {
  const postProcessing = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera, { samples: options.samples ?? 4 });
  postProcessing.outputNode = scenePass.getTextureNode();
  return postProcessing;
}
