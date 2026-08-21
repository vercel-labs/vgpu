import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { PNG } from 'pngjs';
import type { Gpu, Target } from 'vgpu';

import type { ThumbnailOptions } from '../../lib/example-renderer';
import { createHeroGlassAssets, type HeroGlassAssets } from './hero-glass-assets-core';
import {
  createHeroFractalScene,
  destroyHeroFractalScene,
  renderHeroFractalScene,
  setHeroFractalSceneSettings,
  type HeroFractalScene,
} from './scene';
import {
  HERO_FRACTAL_CAMERA,
  HERO_FRACTAL_GLASS,
  HERO_FRACTAL_MATERIAL,
  HERO_ORB_MATERIAL,
} from './settings';

export async function renderThumbnail(
  gpu: Gpu,
  output: Target,
  options: ThumbnailOptions = {}
): Promise<void> {
  const publicAssetsRoot = options.publicAssetsRoot;
  if (!publicAssetsRoot || !isAbsolute(publicAssetsRoot)) {
    throw new Error(
      'glass-fractal renderThumbnail requires options.publicAssetsRoot as an absolute path to apps/docs/public.'
    );
  }

  const assetRoot = join(publicAssetsRoot, 'examples', 'glass-fractal');
  const [glassBytes, fractalBytes, atlasBytes] = await Promise.all([
    readFile(join(assetRoot, 'rounded-tetrahedron.mesh')),
    readFile(join(assetRoot, 'fractal-tetrahedron-l7.mesh')),
    readFile(join(assetRoot, 'studio-cubemap-prefiltered.png')),
  ]);
  const atlas = PNG.sync.read(atlasBytes);
  let assets: HeroGlassAssets | undefined;
  let scene: HeroFractalScene | undefined;

  try {
    assets = createHeroGlassAssets(
      gpu,
      exactArrayBuffer(glassBytes),
      exactArrayBuffer(fractalBytes),
      { width: atlas.width, height: atlas.height, data: atlas.data }
    );
    scene = await createHeroFractalScene(gpu, output, assets, 'glass-fractal-thumb');

    const frameCount = Math.max(1, options.warmupFrames ?? 1);
    const dt = options.dt ?? 0;
    let time = options.time ?? 0;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      setHeroFractalSceneSettings(scene, assets, output.size, {
        camera: HERO_FRACTAL_CAMERA,
        fractalMaterial: HERO_FRACTAL_MATERIAL,
        orbMaterial: HERO_ORB_MATERIAL,
        glass: HERO_FRACTAL_GLASS,
        time,
      });
      renderHeroFractalScene(gpu, output, scene);
      time += dt;
    }
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
  } finally {
    await Promise.allSettled([gpu.gpu.queue.onSubmittedWorkDone(), gpu.settled()]);
    if (scene) destroyHeroFractalScene(scene);
    assets?.dispose();
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
