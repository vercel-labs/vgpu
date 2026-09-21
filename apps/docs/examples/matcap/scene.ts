import type { Draw, Frame, Gpu, Target } from "vgpu";
import { draw, effect, frame, geometry, sampler, target } from "vgpu";
import { icosphere, perspectiveCamera } from "vgpu/scene";

import bakeMatcapWgsl from "./bake-matcap.wgsl";
import matcapWgsl from "./matcap.wgsl";

// 512 is plenty: the texture is only ever sampled across a unit disk, so extra
// resolution buys detail nobody can see on a silhouette this size.
const MATCAP_SIZE: readonly [number, number] = [512, 512];

export interface MatcapScene {
  readonly solid: Draw;
}

export function createScene(gpu: Gpu): MatcapScene {
  // Baked once, into a plain offscreen target. Nothing writes to it again.
  const matcap = target(gpu, { size: MATCAP_SIZE, format: "rgba16float" });
  const bake = effect(gpu, bakeMatcapWgsl);
  frame(gpu, (currentFrame) =>
    currentFrame.pass({ target: matcap }, (pass) => pass.draw(bake))
  );

  // Curvature is what makes a matcap legible: a smooth ball sweeps its normals
  // across the whole disk, so the baked gradient, highlight and rim all land on
  // screen at once. Flat-faced solids sample a single texel per face and throw
  // that gradient away. Convex also means back-face culling resolves visibility
  // on its own, with no depth buffer to size or resize.
  const solid = draw(gpu, {
    shader: matcapWgsl,
    geometry: geometry(gpu, icosphere({ radius: 1, subdivisions: 5 })),
    cull: "back",
  });
  solid.set({
    matcap_tex: matcap,
    matcap_samp: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    }),
  });

  return { solid };
}

export function renderScene(
  currentFrame: Frame,
  scene: MatcapScene,
  output: Target,
  time: number
): void {
  const camera = perspectiveCamera({
    fov: 34,
    aspect: output.size[0] / Math.max(1, output.size[1]),
    near: 0.1,
    far: 20,
    position: [0, 0, 4.4],
    target: [0, 0, 0],
  });
  scene.solid.set({
    view_projection: camera.viewProjection,
    // Matcap lighting lives in view space, which is why the shading stays put
    // while the solid turns underneath it.
    view: camera.view,
    yaw: time * 0.42,
    pitch: 0.34 + Math.sin(time * 0.29) * 0.24,
  });
  currentFrame.pass(output, (pass) => pass.draw(scene.solid));
}
