/**
 * The GPU side of the example: one texture the size of the decoded picture, one
 * cube that samples it, and the two ways bytes get into that texture.
 *
 * Uploads are deliberately separated from rendering. `renderScene` runs every
 * display frame so the cube spins smoothly, while `uploadVideoFrame` is only
 * called when `video-source.ts` reports a genuinely new decoded frame.
 */
import type { Draw, Frame, Geometry, Gpu, Target } from 'vgpu';
import { draw, geometry, sampler } from 'vgpu';
import type { Texture } from 'vgpu/core';
import { box, perspectiveCamera } from 'vgpu/scene';

import cubeWgsl from './cube.wgsl';
import { createTestPattern } from './test-pattern';

/** The video plays onto a unit cube; the camera below is framed for that size. */
const CUBE_SIZE = 1;
const TILT = 0.42;

export interface VideoCubeScene {
  readonly geometry: Geometry;
  readonly cube: Draw;
  readonly texture: Texture;
  readonly width: number;
  readonly height: number;
}

export interface VideoCubeSceneOptions {
  /** Intrinsic size of the frames that will be uploaded. */
  readonly width: number;
  readonly height: number;
  readonly label?: string;
}

export function createScene(gpu: Gpu, options: VideoCubeSceneOptions): VideoCubeScene {
  const label = options.label ?? 'video-to-texture';
  // `copyExternalImageToTexture` requires `render_attachment` on its destination,
  // on top of the `copy_dst` the copy itself needs and the `texture_binding` the
  // shader reads through.
  const texture = gpu.device.createTexture({
    size: [options.width, options.height],
    format: 'rgba8unorm',
    usage: ['texture_binding', 'copy_dst', 'render_attachment'],
    label: `${label}-frame`,
  });

  const geo = geometry(gpu, box({ size: CUBE_SIZE }));
  const cube = draw(gpu, { shader: cubeWgsl, geometry: geo, cull: 'back', label });
  cube.set({
    video_tex: texture,
    video_samp: sampler(gpu, { magFilter: 'linear', minFilter: 'linear' }),
  });

  return { geometry: geo, cube, texture, width: options.width, height: options.height };
}

export function destroyScene(scene: VideoCubeScene): void {
  scene.geometry.destroy();
  scene.texture.destroy();
}

/**
 * Copies the newest decoded frame straight from the video element into the texture.
 *
 * This is the whole cost of a frame update: the browser already has the picture
 * decoded, and the copy stays inside the GPU process rather than travelling through
 * a canvas or an `ImageBitmap`.
 */
export function uploadVideoFrame(gpu: Gpu, scene: VideoCubeScene, source: HTMLVideoElement): void {
  gpu.gpu.queue.copyExternalImageToTexture(
    { source },
    { texture: scene.texture.gpu },
    [scene.width, scene.height],
  );
}

/** Uploads the deterministic stand-in used before the first frame and by the thumbnail. */
export function uploadTestPattern(gpu: Gpu, scene: VideoCubeScene): void {
  const pattern = createTestPattern(scene.width, scene.height);
  const bytesPerRow = Math.ceil((scene.width * 4) / 256) * 256;
  const rows = bytesPerRow === scene.width * 4 ? pattern.rgba : padRows(pattern.rgba, scene.width * 4, bytesPerRow, scene.height);
  gpu.gpu.queue.writeTexture(
    { texture: scene.texture.gpu },
    rows,
    { bytesPerRow, rowsPerImage: scene.height },
    [scene.width, scene.height],
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
      spin: time * 0.45,
      video_aspect: scene.width / Math.max(1, scene.height),
      tilt: TILT,
    },
  });
  currentFrame.pass(output, (pass) => pass.draw(scene.cube));
}

function padRows(
  data: Uint8Array<ArrayBuffer>,
  sourceBytesPerRow: number,
  destinationBytesPerRow: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const padded = new Uint8Array(destinationBytesPerRow * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * sourceBytesPerRow;
    padded.set(data.subarray(start, start + sourceBytesPerRow), row * destinationBytesPerRow);
  }
  return padded;
}
