/**
 * GPU validation for the `prism-rainbow` docs example, run with the Node
 * renderer (`vgpu/node`, Dawn-backed).
 *
 * Two kinds of evidence here, and the split is deliberate:
 *
 *  - **Picture.** The composited frame is measured where the physics says the
 *    rainbow has to be: brighter than the wall, colorful, inside the prism's
 *    shadow and ordered violet-to-red across the fan.
 *  - **Room.** The parts that only exist because the scene is three-dimensional:
 *    the wall covers the frame at every canvas shape, the glass occupies exactly
 *    its own projected area and nothing outside it, and moving the camera slides
 *    the solid against the wall without disturbing the estimate painted on it.
 *
 * Gated on `VGPU_DOCKER_TEST` like every other GPU suite in the repo; the CI
 * `docker-gpu` job runs it, and `optics.test.ts` and `geometry.test.ts` cover the
 * physics and the framing on any machine without a GPU.
 */

import { describe, expect, test } from 'vitest';
import { init, target } from 'vgpu/node';

import {
  DEFAULT_PRISM_CONTROLS,
  type PrismControls,
  type PrismDispersion,
} from '../../../apps/docs/examples/prism-rainbow/types';
import {
  prismSilhouette,
  regionStats,
  renderComposite,
} from '../../../apps/docs/examples/prism-rainbow/validation';

const gpuOnly = process.env.VGPU_DOCKER_TEST !== '1';

const SIZE: readonly [number, number] = [320, 180];

/**
 * Regions of the frame, in normalized coordinates, that the physics pins down.
 * Chosen by measuring a render, not by eye: `fan` is where the beam leaves the
 * glass heading right and down, `wall` is a corner the lamp's cone never reaches.
 */
const REGIONS = {
  fan: { x0: 0.66, y0: 0.44, x1: 0.98, y1: 0.72 },
  wall: { x0: 0.04, y0: 0.04, x1: 0.3, y1: 0.2 },
} as const;

const WALL_ONLY: PrismControls = { ...DEFAULT_PRISM_CONTROLS, view: 'wall' };
const CAUSTIC_ONLY: PrismControls = { ...DEFAULT_PRISM_CONTROLS, view: 'caustic' };

describe.skipIf(gpuOnly)('prism-rainbow picture', () => {
  test('the rainbow lands in the prism’s shadow, and the wall stays dark', async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-picture' });
      await renderComposite(gpu, output);
      const fan = await regionStats(output, REGIONS.fan);
      const wall = await regionStats(output, REGIONS.wall);
      expect(fan.meanLuma).toBeGreaterThan(wall.meanLuma * 2);
      // Each point of a dispersed fan is dominated by one wavelength, so most of
      // its pixels are strongly colored; the wall is lit by nothing and stays the
      // neutral grey the compositor paints it.
      expect(fan.colorfulShare).toBeGreaterThan(0.25);
      expect(wall.colorfulShare).toBeLessThan(0.02);
    } finally {
      gpu.dispose();
    }
  });

  test('the fan is ordered: violet below, red above', async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-order' });
      await renderComposite(gpu, output, { controls: CAUSTIC_ONLY });
      const pixels = await output.read();
      let redY = 0;
      let redCount = 0;
      let violetY = 0;
      let violetCount = 0;
      for (let y = 0; y < SIZE[1]; y++) {
        for (let x = Math.floor(SIZE[0] * 0.62); x < SIZE[0]; x++) {
          const index = (y * SIZE[0] + x) * 4;
          const red = pixels[index]!;
          const green = pixels[index + 1]!;
          const blue = pixels[index + 2]!;
          if (red > 40 && red > blue * 1.5 && red > green * 0.8) {
            redY += y;
            redCount++;
          }
          if (blue > 40 && blue > red * 1.5 && blue > green * 0.9) {
            violetY += y;
            violetCount++;
          }
        }
      }
      expect(redCount).toBeGreaterThan(100);
      expect(violetCount).toBeGreaterThan(100);
      expect(violetY / violetCount).toBeGreaterThan(redY / redCount + SIZE[1] * 0.08);
    } finally {
      gpu.dispose();
    }
  });

  test('peeling the layers back strips the glass, then the wall and the beam', async () => {
    const gpu = await init();
    try {
      const caustic = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-caustic-only' });
      await renderComposite(gpu, caustic, { controls: CAUSTIC_ONLY });
      const wall = await regionStats(caustic, REGIONS.wall);
      const fan = await regionStats(caustic, REGIONS.fan);
      expect(wall.meanLuma).toBeLessThan(0.002);
      expect(fan.meanLuma).toBeGreaterThan(0.1);
    } finally {
      gpu.dispose();
    }
  });

  test('real glass disperses far less than the stylized preset', async () => {
    const gpu = await init();
    try {
      const colorfulness = async (dispersion: PrismDispersion): Promise<number> => {
        const output = target(gpu, { size: SIZE, format: 'rgba8unorm', label: `prism-${dispersion}` });
        await renderComposite(gpu, output, {
          controls: { ...DEFAULT_PRISM_CONTROLS, dispersion, view: 'glass' },
        });
        return (await regionStats(output, REGIONS.fan)).colorfulShare;
      };
      // The claim `types.ts` makes about the presets, measured on the GPU: crown
      // glass throws a white beam with colored edges, not a rainbow.
      expect(await colorfulness('crown')).toBeLessThan(await colorfulness('stylized') / 2);
    } finally {
      gpu.dispose();
    }
  });

  test('swinging the lamp moves the fan', async () => {
    const gpu = await init();
    try {
      const render = async (arc: number): Promise<Uint8Array> => {
        const output = target(gpu, { size: [160, 90], format: 'rgba8unorm', label: `prism-arc-${arc}` });
        await renderComposite(gpu, output, { lampArc: arc });
        return output.read();
      };
      const low = await render(0);
      const high = await render(1);
      expect(changedShare(low, high)).toBeGreaterThan(0.05);
    } finally {
      gpu.dispose();
    }
  });
});

describe.skipIf(gpuOnly)('prism-rainbow room', () => {
  test('the wall covers the frame, so no corner shows the empty room behind it', async () => {
    const gpu = await init();
    try {
      // Every shape the canvas can plausibly take, including the extremes the
      // derived wall size exists for. A shortfall reads as a black wedge in a
      // corner, which is exactly the kind of thing a single 16:9 render misses.
      for (const size of [[320, 180], [180, 320], [320, 320], [480, 120]] as const) {
        const output = target(gpu, { size, format: 'rgba8unorm', label: `prism-cover-${size[0]}x${size[1]}` });
        await renderComposite(gpu, output);
        const pixels = await output.read();
        let darkest = 1;
        for (let index = 0; index < pixels.length; index += 4) {
          const luma = (0.2126 * pixels[index]! + 0.7152 * pixels[index + 1]! + 0.0722 * pixels[index + 2]!) / 255;
          darkest = Math.min(darkest, luma);
        }
        // The wall's own shade never falls this low; a cleared pixel is zero.
        expect(darkest, `${size[0]}x${size[1]} darkest pixel`).toBeGreaterThan(0.01);
      }
    } finally {
      gpu.dispose();
    }
  });

  test('the glass covers its own projected area, and only that', async () => {
    const gpu = await init();
    try {
      const glass = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-glass' });
      await renderComposite(gpu, glass);
      const wall = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-wall-only' });
      await renderComposite(gpu, wall, { controls: WALL_ONLY });

      const box = prismSilhouette(SIZE[0] / Math.max(1, SIZE[1]));
      const [withGlass, withoutGlass] = [await glass.read(), await wall.read()];
      let inside = 0;
      let insideChanged = 0;
      let outsideChanged = 0;
      for (let y = 0; y < SIZE[1]; y++) {
        for (let x = 0; x < SIZE[0]; x++) {
          const base = (y * SIZE[0] + x) * 4;
          let delta = 0;
          for (let channel = 0; channel < 3; channel++) {
            delta = Math.max(delta, Math.abs(withGlass[base + channel]! - withoutGlass[base + channel]!));
          }
          const u = (x + 0.5) / SIZE[0];
          const v = (y + 0.5) / SIZE[1];
          if (u >= box.x0 && u <= box.x1 && v >= box.y0 && v <= box.y1) {
            inside++;
            if (delta > 6) insideChanged++;
          } else if (delta > 0) {
            outsideChanged++;
          }
        }
      }
      // Half of the bounding box, because a triangle fills about half of one: the
      // mesh's projection agrees with the projection `prismSilhouette` predicts
      // from the same vertices and the same camera.
      expect(insideChanged / inside).toBeGreaterThan(0.35);
      // Nothing outside it moved by a single code value. A draw that leaked past
      // its silhouette — a wrong cull, a wrong matrix, a fullscreen pass by
      // mistake — would show up here and nowhere else.
      expect(outsideChanged).toBe(0);
    } finally {
      gpu.dispose();
    }
  });

  test('wireframe overlays the generated topology without retracing the light', async () => {
    const gpu = await init();
    try {
      const solid = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-solid' });
      await renderComposite(gpu, solid);
      const wireframe = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-wireframe' });
      await renderComposite(gpu, wireframe, {
        controls: { ...DEFAULT_PRISM_CONTROLS, wireframe: true },
      });
      const [withoutLines, withLines] = [await solid.read(), await wireframe.read()];
      expect(changedShare(withoutLines, withLines)).toBeGreaterThan(0.004);
      expect(changedShare(withoutLines, withLines)).toBeLessThan(0.12);
    } finally {
      gpu.dispose();
    }
  });

  test('moving the camera slides the glass against the wall', async () => {
    const gpu = await init();
    try {
      const render = async (orbit: readonly [number, number], label: string): Promise<Uint8Array> => {
        const output = target(gpu, { size: SIZE, format: 'rgba8unorm', label });
        await renderComposite(gpu, output, { orbit });
        return output.read();
      };
      const rest = await render([0, 0], 'prism-orbit-rest');
      const swung = await render([1, -1], 'prism-orbit-swung');
      // Parallax: the caustic is painted on a plane at z = 0 and the glass stands
      // in front of it, so a camera move changes their alignment. A composite that
      // had merely pasted the prism onto the wall would move as one piece and
      // change far less.
      expect(changedShare(rest, swung)).toBeGreaterThan(0.02);
    } finally {
      gpu.dispose();
    }
  });
});

describe.skipIf(gpuOnly)('prism-rainbow deterministic mesh', () => {
  test('independent renders produce exactly the same pixels', async () => {
    const gpu = await init();
    try {
      const render = async (): Promise<Uint8Array> => {
        const output = target(gpu, { size: [160, 90], format: 'rgba8unorm', label: 'prism-determinism' });
        await renderComposite(gpu, output);
        return output.read();
      };
      // Nothing in the pipeline reads a clock, history texture or random seed.
      expect(Array.from(await render())).toEqual(Array.from(await render()));
    } finally {
      gpu.dispose();
    }
  });
});

/** Fraction of pixels whose red channel moved by more than a visible step. */
function changedShare(before: Uint8Array, after: Uint8Array): number {
  let changed = 0;
  for (let index = 0; index < before.length; index += 4) {
    if (Math.abs(before[index]! - after[index]!) > 12) changed++;
  }
  return changed / (before.length / 4);
}
