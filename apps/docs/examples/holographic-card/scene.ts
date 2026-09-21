import { effect, sampler, texture, type Gpu, type Target } from 'vgpu';
import { letteringPixels, letteringSize } from './lettering';
import fragment from './shader.wgsl';

/** Shared by the live canvas and deterministic gallery thumbnails. */
export function createScene(gpu: Gpu, output: Target) {
  const lettering = texture(gpu, {
    kind: '2d', size: letteringSize, format: 'r8unorm',
    usage: ['texture_binding', 'copy_dst'], label: 'geist-lettering',
  });
  gpu.gpu.queue.writeTexture(
    { texture: lettering.gpu }, letteringPixels(),
    { bytesPerRow: letteringSize[0] }, [...letteringSize, 1],
  );
  const shader = effect(gpu, fragment, {
    label: 'holographic-card',
    set: {
      params: { resolution: output.size, tilt: [0, 0], pointer: [0.2, -0.25], hover: 0 },
      lettering,
      linear: sampler(gpu, { minFilter: 'linear', magFilter: 'linear' }),
    },
  });
  return shader;
}
