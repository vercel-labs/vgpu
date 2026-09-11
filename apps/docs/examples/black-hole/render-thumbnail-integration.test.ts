import { expect, test } from 'vitest';
import { init, target } from 'vgpu/mock';

import { renderThumbnail } from './render-thumbnail';

test('renders black-hole thumbnail variants through real binding validation', async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [160, 90], format: 'rgba8unorm' });
    const variants: Array<{ name: string; size: readonly [number, number]; bytes: number }> = [];
    await renderThumbnail(gpu, output, {
      onVariantRendered(name, pixels, size) {
        variants.push({ name, size, bytes: pixels.byteLength });
      },
    });
    expect(variants).toEqual([
      { name: 'time-delta', size: [160, 90], bytes: 160 * 90 * 4 },
      { name: 'pointer-orbit', size: [160, 90], bytes: 160 * 90 * 4 },
    ]);
  } finally {
    gpu.dispose();
  }
});
