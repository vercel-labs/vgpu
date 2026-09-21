import { expect, test } from 'vitest';
import { init, target } from 'vgpu/mock';

import { renderThumbnail } from './render-thumbnail';

test('renders fft-ocean-surface through real binding validation', async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [160, 90], format: 'rgba8unorm' });
    await expect(renderThumbnail(gpu, output)).resolves.toBeUndefined();
  } finally {
    gpu.dispose();
  }
});
