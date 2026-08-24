import type { Draw, Frame, Geometry, Gpu, Target } from 'vgpu';
import { draw, geometry } from 'vgpu';
import { disk, icosphere, perspectiveCamera } from 'vgpu/scene';

import clippedWgsl from './clipped.wgsl';

export interface ClippingScene {
  geometries: Geometry[];
  body: Draw;
  cap: Draw;
}

export function createScene(gpu: Gpu): ClippingScene {
  const geometries = [
    geometry(gpu, icosphere({ radius: 1, subdivisions: 4, shading: 'flat' })),
    geometry(gpu, disk({ radius: 1, segments: 64 })),
  ];
  const body = draw(gpu, { shader: clippedWgsl, geometry: geometries[0], cull: 'back' });
  const cap = draw(gpu, { shader: clippedWgsl, geometry: geometries[1], cull: 'back' });
  return { geometries, body, cap };
}

export function destroyScene(scene: ClippingScene): void {
  scene.geometries.forEach((item) => item.destroy());
}

export function renderScene(
  currentFrame: Frame,
  scene: ClippingScene,
  output: Target,
  time: number
): void {
  const camera = perspectiveCamera({
    fov: 36,
    aspect: output.size[0] / Math.max(1, output.size[1]),
    near: 0.1,
    far: 20,
    position: [0, 0, 4.2],
    target: [0, 0, 0],
  });
  const clip = 0.08 + Math.sin(time * 0.72) * 0.46;
  const uniforms = { view_projection: camera.viewProjection, time, clip };
  scene.body.set({ scene: { ...uniforms, cap: 0 } });
  scene.cap.set({ scene: { ...uniforms, cap: 1 } });
  currentFrame.pass(output, (pass) => {
    pass.draw(scene.body);
    pass.draw(scene.cap);
  });
}
