/**
 * GPU validation for the `prism-rainbow` docs example, run with the Node
 * renderer (`vgpu/node`, Dawn-backed).
 *
 * Three kinds of evidence here, and the split is deliberate:
 *
 *  - **Parity.** `probe.wgsl` writes the tracer's internals into an
 *    `rgba32float` target — the sampled point on the glass, the wavelength, the
 *    index of refraction, where the ray left the glass and how, the connection
 *    weight, and the full 16-ray estimate. Every one of those is diffed against
 *    the CPU reference in `optics.ts`. A shader bug shows up as a number, at the
 *    slot that produced it, instead of as "the image looks wrong".
 *  - **Picture.** The composited frame is measured where the physics says the
 *    rainbow has to be: brighter than the wall, colorful, inside the prism's
 *    shadow, ordered violet-to-red across the fan, and converging as frames
 *    accumulate.
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
  estimateRadiance,
  insideTriangle,
  probePoint,
  sceneRay,
  tracePrism,
  traceRayWeight,
  type TraceParams,
} from '../../../apps/docs/examples/prism-rainbow/optics';
import { incidenceAt, traceSize } from '../../../apps/docs/examples/prism-rainbow/scene';
import {
  PRISM_DEFAULT_ARC,
  PRISM_DISPERSION_PRESETS,
  PRISM_EXPOSURE,
  PRISM_MAX_INTERNAL_BOUNCES,
  PRISM_RAYS_PER_FRAGMENT,
  PRISM_TRIANGLE,
  PRISM_WAVELENGTHS,
  lampForIncidence,
  type PrismControls,
  type PrismDispersion,
} from '../../../apps/docs/examples/prism-rainbow/types';
import {
  accumulate,
  prismSilhouette,
  readProbe,
  regionStats,
  renderComposite,
  PROBE_SLOTS,
} from '../../../apps/docs/examples/prism-rainbow/validation';

const gpuOnly = process.env.VGPU_DOCKER_TEST !== '1';

/** The CPU reference configured exactly as the scene uploads it. */
function reference(dispersion: PrismDispersion = 'stylized', arc = PRISM_DEFAULT_ARC): TraceParams {
  return {
    triangle: PRISM_TRIANGLE,
    light: lampForIncidence(incidenceAt(arc)),
    ior: PRISM_DISPERSION_PRESETS[dispersion],
    exposure: PRISM_EXPOSURE,
    raysPerFragment: PRISM_RAYS_PER_FRAGMENT,
    maxBounces: PRISM_MAX_INTERNAL_BOUNCES,
    wavelengths: PRISM_WAVELENGTHS,
  };
}

/**
 * f32 on the GPU against f64 in JavaScript. Geometry survives to 2e-4: the error
 * accumulates through two refractions and a normalize, and no further.
 */
const GEOMETRY_TOLERANCE = 2e-4;

function closeTo(actual: number, expected: number, scale = 1): boolean {
  return Math.abs(actual - expected) <= GEOMETRY_TOLERANCE * Math.max(1, Math.abs(expected) / scale);
}

/**
 * Weights and radiance need a looser bound, and the reason is the estimator's
 * geometry rather than sloppiness. The connection kernel measures how close a
 * ray passes to a lamp 0.05 units wide from 6.5 units away, so it turns an
 * angular error into a weight error multiplied by distance/radius — 130x. An f32
 * direction that differs in its last bits therefore lands measurably further up
 * or down the kernel's slope. 1% still catches every structural bug (a wrong
 * wavelength, colour, exposure or seed moves these by whole factors), which is
 * what this comparison is for.
 */
function closeToWeight(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= Math.max(1e-4, Math.abs(expected) * 0.01);
}

const SIZE: readonly [number, number] = [320, 180];

/**
 * Regions of the frame, in normalized coordinates, that the physics pins down.
 * Chosen by measuring a render, not by eye: `fan` is where the beam leaves the
 * glass heading right and down, `wall` is a corner the lamp's cone never reaches.
 */
const REGIONS = {
  fan: { x0: 0.66, y0: 0.44, x1: 0.98, y1: 0.72 },
  wall: { x0: 0.04, y0: 0.04, x1: 0.3, y1: 0.2 },
  /** Violet is deviated furthest, so it lands below the red end of the fan. */
  fanRed: { x0: 0.72, y0: 0.44, x1: 0.94, y1: 0.53 },
  fanViolet: { x0: 0.8, y0: 0.62, x1: 1.0, y1: 0.74 },
} as const;

const WALL_ONLY: PrismControls = { dispersion: 'stylized', view: 'wall' };
const CAUSTIC_ONLY: PrismControls = { dispersion: 'stylized', view: 'caustic' };

const blueness = (mean: readonly [number, number, number]): number => mean[2] / Math.max(1e-6, mean[0]);

describe.skipIf(gpuOnly)('prism-rainbow shader parity with the CPU reference', () => {
  test('every probe slot agrees: sampling, dispersion, refraction, connection', async () => {
    const gpu = await init();
    try {
      const slots = await readProbe(gpu);
      expect(slots).toHaveLength(PROBE_SLOTS);
      const params = reference();
      let lit = 0;
      let insideGlass = 0;

      for (const slot of slots) {
        const point = probePoint(slot.slot);
        const label = `slot ${slot.slot} at (${point[0].toFixed(2)}, ${point[1].toFixed(2)})`;
        // The shader's own idea of which point it probed, so a grid drift in
        // either implementation is caught before anything else is compared.
        expect(closeTo(slot.point[0], point[0]), `${label} point.x`).toBe(true);
        expect(closeTo(slot.point[1], point[1]), `${label} point.y`).toBe(true);

        const ray = sceneRay(params, [slot.slot, 0], 0, slot.slot % PRISM_RAYS_PER_FRAGMENT);
        expect(closeTo(slot.aim[0], ray.aim[0]), `${label} aim.x`).toBe(true);
        expect(closeTo(slot.aim[1], ray.aim[1]), `${label} aim.y`).toBe(true);
        // The sampled point has to be on the glass for the ray to mean anything.
        expect(insideTriangle(PRISM_TRIANGLE, [slot.aim[0], slot.aim[1]]), `${label} aim on glass`).toBe(true);
        expect(closeTo(slot.wavelength, ray.wavelength, 100), `${label} wavelength`).toBe(true);
        expect(closeTo(slot.ior, ray.ior), `${label} ior`).toBe(true);

        const towardsAim: readonly [number, number] = [ray.aim[0] - point[0], ray.aim[1] - point[1]];
        const distance = Math.hypot(towardsAim[0], towardsAim[1]);
        const path = tracePrism(
          PRISM_TRIANGLE,
          point,
          [towardsAim[0] / distance, towardsAim[1] / distance],
          ray.ior,
          PRISM_MAX_INTERNAL_BOUNCES,
        );
        expect(slot.valid, `${label} found a path`).toBe(path !== undefined);
        if (path) {
          expect(closeTo(slot.exitOrigin[0], path.origin[0]), `${label} exit.x`).toBe(true);
          expect(closeTo(slot.exitOrigin[1], path.origin[1]), `${label} exit.y`).toBe(true);
          expect(closeTo(slot.exitDirection[0], path.direction[0]), `${label} exit direction.x`).toBe(true);
          expect(closeTo(slot.exitDirection[1], path.direction[1]), `${label} exit direction.y`).toBe(true);
          expect(slot.bounces, `${label} bounces`).toBe(path.bounces);
          const weight = traceRayWeight(
            PRISM_TRIANGLE,
            params.light,
            point,
            ray.aim,
            ray.ior,
            PRISM_MAX_INTERNAL_BOUNCES,
          );
          expect(closeToWeight(slot.weight, weight), `${label} weight ${slot.weight} vs ${weight}`).toBe(true);
        } else if (insideTriangle(PRISM_TRIANGLE, point)) {
          // A fragment inside the glass has no outside-in path and must stay dark.
          insideGlass++;
          expect(slot.radiance.every((channel) => channel === 0), `${label} glass is unlit`).toBe(true);
        }

        const radiance = estimateRadiance(params, point, [slot.slot, 0], 0);
        for (let channel = 0; channel < 3; channel++) {
          expect(
            closeToWeight(slot.radiance[channel]!, radiance[channel]!),
            `${label} radiance[${channel}] ${slot.radiance[channel]} vs ${radiance[channel]}`,
          ).toBe(true);
        }
        if (Math.max(...slot.radiance) > 0) lit++;
      }

      // A parity run over an all-black frame would prove nothing.
      expect(lit, 'probe slots that carried light').toBeGreaterThan(0);
      expect(insideGlass, 'probe slots inside the glass').toBeGreaterThan(0);
    } finally {
      gpu.dispose();
    }
  });

  test('the probe follows the lamp and the glass, not a hardcoded configuration', async () => {
    const gpu = await init();
    try {
      const swung = await readProbe(gpu, { lampArc: 1, frameIndex: 3 });
      const params = reference('flint', 1);
      // A different arc position, a different preset and a different frame: all
      // three have to reach the shader for this to line up.
      const flint = await readProbe(gpu, {
        lampArc: 1,
        frameIndex: 3,
        controls: { dispersion: 'flint', view: 'glass' },
      });
      expect(flint.map((slot) => slot.ior)).not.toEqual(swung.map((slot) => slot.ior));
      for (const slot of flint) {
        const ray = sceneRay(params, [slot.slot, 0], 3, slot.slot % PRISM_RAYS_PER_FRAGMENT);
        expect(closeTo(slot.ior, ray.ior), `slot ${slot.slot} ior`).toBe(true);
        expect(closeTo(slot.aim[0], ray.aim[0]), `slot ${slot.slot} aim.x`).toBe(true);
        const radiance = estimateRadiance(params, probePoint(slot.slot), [slot.slot, 0], 3);
        for (let channel = 0; channel < 3; channel++) {
          expect(closeToWeight(slot.radiance[channel]!, radiance[channel]!), `slot ${slot.slot} radiance`).toBe(true);
        }
      }
    } finally {
      gpu.dispose();
    }
  });
});

describe.skipIf(gpuOnly)('prism-rainbow picture', () => {
  test('the rainbow lands in the prism’s shadow, and the wall stays dark', async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-picture' });
      await renderComposite(gpu, output, 160);
      const fan = await regionStats(output, REGIONS.fan);
      const wall = await regionStats(output, REGIONS.wall);
      expect(fan.meanLuma).toBeGreaterThan(wall.meanLuma * 3);
      // Each point of a dispersed fan is dominated by one wavelength, so most of
      // its pixels are strongly colored; the wall is lit by nothing and stays the
      // neutral grey the compositor paints it.
      expect(fan.colorfulShare).toBeGreaterThan(0.4);
      expect(wall.colorfulShare).toBeLessThan(0.02);
    } finally {
      gpu.dispose();
    }
  });

  test('the fan is ordered: violet below, red above', async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-order' });
      await renderComposite(gpu, output, 160);
      const violet = await regionStats(output, REGIONS.fanViolet);
      const red = await regionStats(output, REGIONS.fanRed);
      // Violet is refracted furthest, so it leaves on the steepest heading and
      // lands below red. Compare hue, not brightness — and compare the two ends
      // against each other rather than against an absolute, because how much wall
      // each band shares its region with depends on the framing.
      expect(blueness(violet.mean)).toBeGreaterThan(3 * blueness(red.mean));
      expect(blueness(red.mean)).toBeLessThan(0.6);
    } finally {
      gpu.dispose();
    }
  });

  test('peeling the layers back strips the glass, then the wall and the beam', async () => {
    const gpu = await init();
    try {
      const caustic = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-caustic-only' });
      await renderComposite(gpu, caustic, 96, { controls: CAUSTIC_ONLY });
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
        await renderComposite(gpu, output, 128, { controls: { dispersion, view: 'glass' } });
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
        await renderComposite(gpu, output, 64, { lampArc: arc });
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
        await renderComposite(gpu, output, 24);
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
      await renderComposite(gpu, glass, 128);
      const wall = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-wall-only' });
      await renderComposite(gpu, wall, 128, { controls: WALL_ONLY });

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

  test('the solid reads against the wall it stands on', async () => {
    const gpu = await init();
    try {
      const glass = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-lit' });
      await renderComposite(gpu, glass, 128);
      const wall = target(gpu, { size: SIZE, format: 'rgba8unorm', label: 'prism-unlit' });
      await renderComposite(gpu, wall, 128, { controls: WALL_ONLY });
      // A patch at the middle of the cross-section, well inside the silhouette.
      const box = prismSilhouette(SIZE[0] / Math.max(1, SIZE[1]));
      const centre = {
        x0: (box.x0 + box.x1) / 2 - 0.03,
        y0: (box.y0 + box.y1) / 2 - 0.03,
        x1: (box.x0 + box.x1) / 2 + 0.03,
        y1: (box.y0 + box.y1) / 2 + 0.03,
      };
      const lit = await regionStats(glass, centre);
      const bare = await regionStats(wall, centre);
      // The room is nearly black, so the glass is carried by what it reflects.
      // If the environment stopped reaching it the object would vanish into the
      // wall, which is a silent failure the diff test above cannot see.
      expect(lit.meanLuma).toBeGreaterThan(bare.meanLuma * 1.5);
    } finally {
      gpu.dispose();
    }
  });

  test('moving the camera slides the glass against the wall', async () => {
    const gpu = await init();
    try {
      const render = async (orbit: readonly [number, number], label: string): Promise<Uint8Array> => {
        const output = target(gpu, { size: SIZE, format: 'rgba8unorm', label });
        await renderComposite(gpu, output, 96, { orbit });
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

describe.skipIf(gpuOnly)('prism-rainbow accumulation', () => {
  test('more frames means less noise, without changing what is being estimated', async () => {
    const gpu = await init();
    try {
      const few = await accumulate(gpu, [320, 180], 4);
      const many = await accumulate(gpu, [320, 180], 256);
      for (const stats of [few, many]) {
        expect(stats.finite).toBe(true);
        expect(stats.negative).toBe(0);
        expect(stats.mean).toBeGreaterThan(0);
      }
      // The caustic is a smooth field, so the difference between neighbouring
      // pixels is almost entirely sampling noise. It has to fall as frames
      // accumulate — this is the assertion that the ping-pong average works
      // rather than the pass simply overwriting itself every frame.
      expect(many.neighbourNoise).toBeLessThan(few.neighbourNoise / 2);
      // ...while the estimate itself stays put: averaging is not dimming.
      expect(many.mean).toBeGreaterThan(few.mean * 0.6);
      expect(many.mean).toBeLessThan(few.mean * 1.6);
    } finally {
      gpu.dispose();
    }
  });

  test('the accumulation buffer is smaller than the canvas, on purpose', async () => {
    expect(traceSize([1280, 720])).toEqual([640, 360]);
    expect(traceSize([400, 300])).toEqual([240, 180]);
    // Never zero, whatever the canvas does mid-resize.
    expect(traceSize([1, 1])).toEqual([1, 1]);
  });

  test('the same frame count always produces the same pixels', async () => {
    const gpu = await init();
    try {
      const render = async (): Promise<Uint8Array> => {
        const output = target(gpu, { size: [160, 90], format: 'rgba8unorm', label: 'prism-determinism' });
        await renderComposite(gpu, output, 32);
        return output.read();
      };
      // Nothing in the pipeline reads a clock, so a headless render of n frames
      // is reproducible — which is what lets the thumbnail be a committed PNG.
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
