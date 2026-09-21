import { describe, expect, it, vi } from 'vitest';
import { frame, init, target } from 'vgpu/mock';
import type { Frame } from 'vgpu';
import { cameraUniforms, smoothAltitude, smoothSunAngles, sunDirection } from './camera';
import { CLOUD_CONVERGENCE_FRAMES, CLOUD_FAST_REFRESH_PERIOD, applyState, bakeLuts, createGraph, createRenderer, destroyGraph, encodeCloudShadow, encodeSunShadow, renderGraph, resizeGraph, sunShadowUniformValues } from './renderer';
import { ATMOSPHERE_PHYSICS, LUT_SIZES, PRESETS, type AtmosphereState } from './tuning';

const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('atmosphere camera', () => {
  it('eases altitude at the same rate across frame rates and settles at both slider endpoints', () => {
    for (const [start, target] of [[0, 4], [4, 0]] as const) {
      for (const fps of [30, 60, 120]) {
        let altitude: number = start;
        for (let i = 0; i < fps / 2; i++) altitude = smoothAltitude(altitude, target, 1 / fps);
        expect(altitude).toBeCloseTo(target + (start - target) * Math.exp(-6), 9);
        for (let i = 0; i < fps; i++) altitude = smoothAltitude(altitude, target, 1 / fps);
        expect(altitude).toBe(target);
        expect(smoothAltitude(altitude, target, 1 / fps)).toBe(target);
      }
    }
    expect(smoothAltitude(0, 4, 0)).toBe(0);
    expect(smoothAltitude(0, 4, -1)).toBe(0);
    expect(smoothAltitude(0, 4, 10)).toBe(smoothAltitude(0, 4, 0.1));
    expect(smoothAltitude(0, 4, 10)).toBeLessThan(4);
    const rising = smoothAltitude(0, 4, 1 / 60);
    expect(smoothAltitude(rising, 0, 1 / 60)).toBeGreaterThan(0);
    expect(smoothAltitude(rising, 0, 1 / 60)).toBeLessThan(rising);
  });

  it('keeps curved ground and elevated receivers inside invertible shadow bounds on either side of sunset', () => {
    const transform = (matrix: readonly number[], p: readonly number[]) => [0, 1, 2, 3].map((row) =>
      matrix[row]! * p[0]! + matrix[4 + row]! * p[1]! + matrix[8 + row]! * p[2]! + matrix[12 + row]! * p[3]!);
    for (const sunElevation of [-12, -2, -0.01, 0, 0.01, 12, 90]) {
      const shadow = sunShadowUniformValues(sunDirection({ ...PRESETS.noon, sunElevation }));
      for (const [index, matrix] of [shadow.toShadow0, shadow.toShadow1, shadow.toShadow2].entries()) {
        const radius = shadow.radii[index]!;
        const planetRadius = ATMOSPHERE_PHYSICS.groundRadius;
        const floor = -radius * radius / (planetRadius + Math.sqrt(planetRadius * planetRadius - radius * radius));
        for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 4) for (const height of [floor, 6]) {
          const point = [radius * Math.sin(angle), height, radius * Math.cos(angle), 1];
          const clip = transform(matrix, point);
          expect(Math.abs(clip[0]!)).toBeLessThanOrEqual(1 + 1e-9);
          expect(Math.abs(clip[1]!)).toBeLessThanOrEqual(1 + 1e-9);
          expect(clip[2]!).toBeGreaterThanOrEqual(-1e-9);
          expect(clip[2]!).toBeLessThanOrEqual(1 + 1e-9);
          if (index > 0) {
            const restored = transform(index === 1 ? shadow.fromShadow1 : shadow.fromShadow2, clip);
            restored.forEach((value, axis) => expect(value).toBeCloseTo(point[axis]!, 8));
          }
        }
      }
    }
  });

  it('eases the sun at the same rate at 30, 60 and 120 fps', () => {
    const target = { sunElevation: 60, sunAzimuth: 80 };
    const results = [30, 60, 120].map((fps) => {
      let sun = { sunElevation: 10, sunAzimuth: 0 };
      for (let i = 0; i < fps / 2; i++) sun = smoothSunAngles(sun, target, 1 / fps);
      return sun;
    });
    for (const sun of results) {
      expect(sun.sunElevation).toBeCloseTo(results[0]!.sunElevation, 9);
      expect(sun.sunAzimuth).toBeCloseTo(results[0]!.sunAzimuth, 9);
      expect(sun.sunElevation).toBeGreaterThan(57);
      expect(sun.sunElevation).toBeLessThan(target.sunElevation);
    }
    expect(target).toEqual({ sunElevation: 60, sunAzimuth: 80 });
  });

  it('takes the short azimuth path across the wrap in either direction and settles exactly', () => {
    for (const direction of [-1, 1]) {
      let sun = { sunElevation: 4, sunAzimuth: direction * 179 };
      const target = { sunElevation: 40, sunAzimuth: -direction * 179 };
      sun = smoothSunAngles(sun, target, 1 / 60);
      expect(direction * sun.sunAzimuth).toBeGreaterThan(179);
      expect(direction * sun.sunAzimuth).toBeLessThan(181);
      for (let i = 0; i < 90; i++) sun = smoothSunAngles(sun, target, 1 / 60);
      expect(sun).toEqual(target);
      expect(smoothSunAngles(sun, target, 1 / 60)).toEqual(target);
    }
  });

  it('holds for zero elapsed time and limits the jump after a paused tab resumes', () => {
    const sun = { sunElevation: 4, sunAzimuth: 58 };
    const target = { sunElevation: 90, sunAzimuth: -100 };
    expect(smoothSunAngles(sun, target, 0)).toEqual(sun);
    expect(smoothSunAngles(sun, target, 10)).toEqual(smoothSunAngles(sun, target, 0.1));
    expect(smoothSunAngles(sun, target, 10).sunElevation).toBeLessThan(90);
  });

  it('builds an orthonormal basis that looks along yaw/pitch', () => {
    const camera = cameraUniforms({ ...PRESETS.noon, yaw: 90, pitch: 0 }, [1280, 720]);
    expect(camera.forward[0]).toBeCloseTo(1, 6);
    expect(camera.forward[1]).toBeCloseTo(0, 6);
    expect(dot(camera.forward, camera.right)).toBeCloseTo(0, 6);
    expect(dot(camera.forward, camera.up)).toBeCloseTo(0, 6);
    expect(dot(camera.right, camera.up)).toBeCloseTo(0, 6);
    expect(camera.up[1]).toBeGreaterThan(0.99);
    expect(camera.aspect).toBeCloseTo(1280 / 720, 6);
    expect(camera.position[1]).toBeCloseTo(6360 + PRESETS.noon.altitudeKm, 6);
  });

  it('places the sun from elevation and azimuth', () => {
    const zenith = sunDirection({ ...PRESETS.noon, sunElevation: 90 });
    expect(zenith[1]).toBeCloseTo(1, 6);
    const horizon = sunDirection({ ...PRESETS.noon, sunElevation: 0, sunAzimuth: 0 });
    expect(horizon).toEqual([0, 0, 1]);
  });

  it('clamps the altitude to the atmosphere', () => {
    const camera = cameraUniforms({ ...PRESETS.noon, altitudeKm: 500 }, [64, 64]);
    expect(camera.position[1]).toBeLessThan(6460);
  });
});

describe('atmosphere graph on the mock adapter', () => {
  it('renders terrain shadow occluders below, at and above zero sun elevation', async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: [96, 54], format: 'rgba8unorm' });
      const graph = await createGraph(gpu, output, 'sunset-shadow-test');
      const draw = vi.fn();
      const current = { pass: (_options: unknown, encode: (pass: { draw: typeof draw }) => void) => encode({ draw }) } as unknown as Frame;
      for (const sunElevation of [-0.1, 0, 0.1]) {
        applyState(graph, { ...PRESETS.noon, sunElevation }, output.size);
        draw.mockClear();
        encodeSunShadow(current, graph);
        expect(draw).toHaveBeenCalledTimes(3);
        encodeSunShadow(current, graph);
        expect(draw).toHaveBeenCalledTimes(3);
      }
      await gpu.settled();
    } finally {
      gpu.dispose();
    }
  });

  it('updates and releases both cloud shadow cascades, skipping their work when disabled', async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: [96, 54], format: 'rgba8unorm' });
      const graph = await createGraph(gpu, output, 'cloud-cascades-test');
      expect(graph.cloudShadowNearMap.size).toEqual([512, 512]);
      expect(graph.cloudShadowNearMap).not.toBe(graph.cloudShadowMap);
      const dispatch = vi.spyOn(graph.cloudShadowCompute, 'dispatch');
      const blur = vi.spyOn(graph.cloudShadowBlurCompute, 'dispatch');
      applyState(graph, PRESETS.noon, output.size);
      encodeCloudShadow(graph);
      // Each z workgroup layer fills a distinct cascade; both are ready before their consumers run.
      expect(dispatch).toHaveBeenLastCalledWith(64, 64, 2);
      expect(blur).toHaveBeenLastCalledWith(64, 64, 1);
      expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(blur.mock.invocationCallOrder[0]!);
      for (const state of [{ ...PRESETS.noon, cloudShadows: false }, { ...PRESETS.noon, cloudCoverage: 0 }]) {
        applyState(graph, state, output.size);
        encodeCloudShadow(graph);
      }
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(blur).toHaveBeenCalledTimes(1);
      applyState(graph, PRESETS.noon, output.size);
      encodeCloudShadow(graph);
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(blur).toHaveBeenCalledTimes(2);
      const rawDestroy = vi.spyOn(graph.cloudShadowNearRaw, 'destroy');
      const nearDestroy = vi.spyOn(graph.cloudShadowNearMap, 'destroy');
      const farDestroy = vi.spyOn(graph.cloudShadowMap, 'destroy');
      await gpu.settled();
      destroyGraph(graph);
      expect(nearDestroy).toHaveBeenCalledOnce();
      expect(rawDestroy).toHaveBeenCalledOnce();
      expect(farDestroy).toHaveBeenCalledOnce();
    } finally {
      gpu.dispose();
    }
  });

  it('accumulates new haze samples at rest and discards history on view, lighting, time and size changes', async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: [96, 54], format: 'rgba8unorm' });
      const graph = await createGraph(gpu, output, 'haze-test');
      const update = vi.spyOn(graph.hazeUpdate, 'set');
      const draw = () => frame(gpu, (current) => renderGraph(current, graph, output));
      let state: AtmosphereState = { ...PRESETS['golden-hour'] };
      applyState(graph, state, output.size);
      bakeLuts(gpu, graph);
      const firstTarget = graph.hazeTargets.write;
      draw();
      expect(graph.hazeTargets.read).toBe(firstTarget);
      expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ valid: 0, blend: 1, phase: 0 }));
      for (let i = 0; i < 24; i++) draw();
      expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ valid: 1, blend: 1 / 16 }));
      expect(new Set(update.mock.calls.map(([value]) => value.phase)).size).toBe(25);

      // Wind and display-only controls preserve the accumulation in linear radiance.
      state = { ...state, time: 1 / 60, exposureEv: 6, tonemap: 'aces' };
      applyState(graph, state, output.size);
      draw();
      expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ valid: 1 }));

      for (const change of [{ yaw: 42 }, { pitch: 12 }, { altitudeKm: 0.1 }, { sunElevation: 8.1 }, { haze: 4 }, { cloudShadows: false }, { cloudCoverage: 0.4 }, { cloudSeed: 2 }, { time: 10 }, { time: 0 }]) {
        state = { ...state, ...change };
        applyState(graph, state, output.size);
        draw();
        expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ valid: 0, blend: 1 }));
        // Allow the deferred LUTs to settle, then accumulation resumes.
        for (let i = 0; i < 3; i++) draw();
        expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ valid: 1 }));
      }
      output.resize([101, 57]);
      resizeGraph(graph, output.size);
      applyState(graph, state, output.size);
      draw();
      expect(graph.hazeMarch.size).toEqual([101, 57]);
      expect(graph.hazeTargets.read.size).toEqual([101, 57]);
      expect(graph.hazeTargets.write.size).toEqual([101, 57]);
      expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ valid: 0, blend: 1 }));
      await gpu.settled();
    } finally {
      gpu.dispose();
    }
  });

  it('creates the storage LUTs, bakes and renders one frame without binding errors', async () => {
    const gpu = await init();
    try {
      const output = target(gpu, { size: [96, 54], format: 'rgba8unorm' });
      const graph = await createGraph(gpu, output, 'atmosphere-test');
      expect(graph.aerial.dimension).toBe('3d');
      expect(graph.aerial.size).toEqual([96, 64, 32]);
      expect([...graph.multiScatter.usage]).toContain('storage_binding');
      expect(graph.shapeNoise.dimension).toBe('3d');
      expect(graph.shapeNoise.format).toBe('rgba8unorm');
      // Clouds render at half resolution and are upsampled by the present pass.
      expect(graph.cloudsTargets.write.size).toEqual([48, 27]);
      expect(graph.curlNoise.format).toBe('rgba8unorm');
      expect(graph.terrainMap.size).toEqual([2048, 2048]);
      expect([...graph.terrainMap.usage]).toContain('storage_binding');
      expect(graph.sunShadows).toHaveLength(3);
      expect(graph.sunShadows[0]?.size).toEqual([2048, 2048]);
      expect(graph.cloudShadowMap.size).toEqual([512, 512]);
      expect(graph.sunShadows[2]?.depth?.format).toBe('depth32float');
      expect(graph.aerialDirect.dimension).toBe('3d');
      expect(graph.terrainDepth.depth?.format).toBe('depth32float');
      expect(graph.bakedSunDirection).toBeUndefined();
      applyState(graph, PRESETS['golden-hour'], output.size);
      expect(graph.lutPhase).toBe('stale');
      // Golden hour looks at the horizon: a sector of the terrain ring grid, not the whole circle.
      expect(graph.terrainColumns).toBeGreaterThan(0);
      expect(graph.terrainColumns).toBeLessThan(4096);
      bakeLuts(gpu, graph);
      expect(graph.lutPhase).toBe('ready');
      expect(() => frame(gpu, (current) => renderGraph(current, graph, output))).not.toThrow();
      // The sun's shadow map is rendered on the first frame for the current sun.
      expect(graph.bakedSunDirection).toEqual(sunDirection(PRESETS['golden-hour']));
      // Changing the haze invalidates the medium-dependent tables; the next frame re-encodes them.
      applyState(graph, { ...PRESETS['golden-hour'], haze: 4 }, output.size);
      expect(graph.lutPhase).toBe('stale');
      // It also stales the cloud history: the next frames refresh clouds four times faster than at rest.
      expect(graph.cloudChangeFrames).toBe(CLOUD_FAST_REFRESH_PERIOD);
      expect(graph.cloudMarch.size).toEqual(graph.cloudsTargets.write.size);
      frame(gpu, (current) => renderGraph(current, graph, output));
      expect(graph.lutPhase).toBe('transmittance');
      frame(gpu, (current) => renderGraph(current, graph, output));
      expect(graph.lutPhase).toBe('ready');
      // The temporal cloud update alternates the ping-pong buffers and counts frames.
      const before = graph.cloudsTargets.write;
      frame(gpu, (current) => renderGraph(current, graph, output));
      expect(graph.cloudsTargets.read).toBe(before);
      expect(graph.frame).toBe(4);
      // Moving the sun re-renders the shadow map on the next frame.
      applyState(graph, { ...PRESETS['golden-hour'], haze: 4, sunElevation: 12 }, output.size);
      expect(graph.bakedSunDirection).toEqual(sunDirection(PRESETS['golden-hour']));
      frame(gpu, (current) => renderGraph(current, graph, output));
      expect(graph.bakedSunDirection).toEqual(sunDirection({ ...PRESETS['golden-hour'], sunElevation: 12 }));
      expect(CLOUD_CONVERGENCE_FRAMES).toBe(16);
      await gpu.settled();
    } finally {
      gpu.dispose();
    }
  });
});

describe('atmosphere renderer lifecycle', () => {
  it('finishes a stale Strict Mode cleanup before reconfiguring the same canvas', async () => {
    const canvas = {} as HTMLCanvasElement;
    const firstInitialization = deferred<() => void>();
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const firstStart = vi.fn(() => firstInitialization.promise);
    const secondStart = vi.fn(async () => secondCleanup);

    const first = createRenderer({ canvas }, firstStart);
    await vi.waitFor(() => expect(firstStart).toHaveBeenCalledOnce());
    first.dispose();

    const second = createRenderer({ canvas }, secondStart);
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    firstInitialization.resolve(firstCleanup);
    await first.ready;
    await second.ready;

    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(secondStart).toHaveBeenCalledOnce();
    expect(firstCleanup.mock.invocationCallOrder[0]).toBeLessThan(secondStart.mock.invocationCallOrder[0]!);

    second.dispose();
    expect(secondCleanup).toHaveBeenCalledOnce();
  });

  it('holds the canvas until an initialized renderer is disposed', async () => {
    const canvas = {} as HTMLCanvasElement;
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const first = createRenderer({ canvas }, async () => firstCleanup);
    const secondStart = vi.fn(async () => secondCleanup);
    const second = createRenderer({ canvas }, secondStart);

    await first.ready;
    await Promise.resolve();
    expect(secondStart).not.toHaveBeenCalled();

    first.dispose();
    await second.ready;
    expect(secondStart).toHaveBeenCalledOnce();

    second.dispose();
  });
});
