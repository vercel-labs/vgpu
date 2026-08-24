import type { Draw, Frame, Geometry, Gpu, Target } from 'vgpu';
import { draw, geometry, sampler } from 'vgpu';
import type { Texture } from 'vgpu/core';
import { box, perspectiveCamera } from 'vgpu/scene';

import cubeWgsl from './cube.wgsl';

/** Size of the committed clip, and the fallback when no video is available. */
export const FRAME_SIZE = { width: 640, height: 360 } as const;

const TILT = 0.42;
/**
 * Radians per second. Deliberately slow: the cube is a screen, so a face has to stay
 * turned towards the viewer long enough to watch what is playing on it. At this rate
 * a face holds a readable angle for roughly the length of the clip.
 *
 * `render-thumbnail.ts` derives its fixed pose from this, so changing it cannot
 * silently rotate the thumbnail.
 */
export const SPIN_RATE = 0.15;

export interface VideoCubeScene {
  readonly geometry: Geometry;
  readonly cube: Draw;
  readonly texture: Texture;
  readonly width: number;
  readonly height: number;
}

export function createScene(gpu: Gpu, size: { width: number; height: number }): VideoCubeScene {
  // `copyExternalImageToTexture` requires `render_attachment` on its destination, on
  // top of the `copy_dst` the copy needs and the `texture_binding` the shader reads.
  const texture = gpu.device.createTexture({
    size: [size.width, size.height],
    format: 'rgba8unorm',
    usage: ['texture_binding', 'copy_dst', 'render_attachment'],
    label: 'video-to-texture-frame',
  });

  const geo = geometry(gpu, box({ size: 1 }));
  const cube = draw(gpu, {
    shader: cubeWgsl,
    geometry: geo,
    cull: 'back',
    label: 'video-to-texture',
  });
  cube.set({
    video_tex: texture,
    video_samp: sampler(gpu, { magFilter: 'linear', minFilter: 'linear' }),
  });

  return { geometry: geo, cube, texture, width: size.width, height: size.height };
}

export function destroyScene(scene: VideoCubeScene): void {
  scene.geometry.destroy();
  scene.texture.destroy();
}

/**
 * Copies the newest decoded frame straight from the video element into the texture.
 *
 * This is the entire cost of a frame update: the browser already holds the picture
 * decoded, and the copy stays GPU-side rather than routing through a canvas or an
 * `ImageBitmap`.
 */
export function uploadFrame(gpu: Gpu, scene: VideoCubeScene, source: HTMLVideoElement): void {
  gpu.gpu.queue.copyExternalImageToTexture(
    { source },
    { texture: scene.texture.gpu },
    [scene.width, scene.height],
  );
}

/**
 * Colour bars with a *dark* top eighth, uploaded before the first decoded frame and
 * by the codec-free thumbnail. The band has to be dark: the bars sit near saturation,
 * so a brighter marker would clip and prove nothing, whereas this makes an upside
 * down or transposed sampling obvious at a glance.
 */
export function uploadTestPattern(gpu: Gpu, scene: VideoCubeScene): void {
  const { width, height } = scene;
  const bars = [
    [235, 235, 235],
    [235, 210, 60],
    [60, 210, 235],
    [60, 200, 90],
    [220, 80, 200],
    [220, 70, 60],
    [50, 70, 200],
    [24, 24, 28],
  ];
  // `writeTexture` needs rows aligned to 256 bytes, so write straight at that stride.
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const data = new Uint8Array(bytesPerRow * height);
  const barWidth = width / bars.length;
  const bandHeight = Math.max(1, Math.round(height / 8));
  const gridX = Math.max(8, Math.round(width / 12));
  const gridY = Math.max(8, Math.round(height / 8));

  for (let y = 0; y < height; y += 1) {
    const gain = y < bandHeight ? 0.35 : 1;
    for (let x = 0; x < width; x += 1) {
      const bar = bars[Math.min(bars.length - 1, Math.floor(x / barWidth))]!;
      const grid = x % gridX === 0 || y % gridY === 0 ? 40 : 0;
      const offset = y * bytesPerRow + x * 4;
      data[offset] = clamp(bar[0]! * gain + grid);
      data[offset + 1] = clamp(bar[1]! * gain + grid);
      data[offset + 2] = clamp(bar[2]! * gain + grid);
      data[offset + 3] = 255;
    }
  }

  gpu.gpu.queue.writeTexture(
    { texture: scene.texture.gpu },
    data,
    { bytesPerRow, rowsPerImage: height },
    [width, height],
  );
}

export function renderScene(
  currentFrame: Frame,
  scene: VideoCubeScene,
  output: Target,
  time: number,
): void {
  const camera = perspectiveCamera({
    fov: 38,
    aspect: output.size[0] / Math.max(1, output.size[1]),
    near: 0.1,
    far: 20,
    position: [0, 0, 2.6],
    target: [0, 0, 0],
  });
  scene.cube.set({
    scene: {
      view_projection: camera.viewProjection,
      spin: time * SPIN_RATE,
      video_aspect: scene.width / Math.max(1, scene.height),
      tilt: TILT,
    },
  });
  currentFrame.pass(output, (pass) => pass.draw(scene.cube));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
