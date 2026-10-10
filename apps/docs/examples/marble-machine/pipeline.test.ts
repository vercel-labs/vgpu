import { expect, test, vi } from 'vitest';

const fakes = vi.hoisted(() => {
  const compiled: Array<{ label: string; against: unknown }> = [];
  const resource = (kind: string, options: Record<string, unknown> = {}) => {
    const value: Record<string, unknown> = {
      kind,
      ...options,
      set: vi.fn(),
      resize: vi.fn((size: readonly [number, number]) => {
        value.size = size;
      }),
      compile: vi.fn(async (against: unknown) => {
        compiled.push({ label: String(options.label ?? kind), against });
      }),
    };
    return value;
  };
  return { compiled, resource };
});

vi.mock('vgpu', () => ({
  draw: vi.fn((_gpu: unknown, options: Record<string, unknown>) => fakes.resource('draw', options)),
  effect: vi.fn((_gpu: unknown, shader: unknown) => fakes.resource('effect', { label: 'present', shader })),
  geometry: vi.fn((_gpu: unknown, recipe: unknown) => ({ recipe })),
  sampler: vi.fn((_gpu: unknown, options: unknown) => ({ kind: 'sampler', options })),
  target: vi.fn((_gpu: unknown, options: Record<string, unknown>) => fakes.resource('target', options)),
  uniforms: vi.fn((_gpu: unknown, values: unknown) => ({ ...fakes.resource('uniforms'), values })),
}));
vi.mock('vgpu/scene/gpu', () => ({
  instanceGeometry: vi.fn((_gpu: unknown, collection: { count: number }, options: unknown) => ({
    options,
    geometry: { collection },
    publish: vi.fn(() => collection.count),
  })),
}));

import { createCamera, createFocus, lightMatrices, updateCamera, updateFocus } from './camera';
import { SHADOW_MAP_SIZE, createPipeline, encode, publish, resizePipeline, type StudioView } from './pipeline';
import { MESHES, createScene, syncMarbles } from './scene';
import { createSimulation } from './simulation';

async function build(simulation = createSimulation({ primeSteps: 0, autoRelease: false })) {
  const scene = createScene(simulation);
  const camera = createCamera();
  updateCamera(camera, updateFocus(createFocus(), 'machine', simulation), 16 / 9, 0);
  const light = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
  const view: StudioView = {
    camera: camera.matrices,
    eye: camera.pose.position,
    fov: camera.lens.fov,
    aspect: 16 / 9,
    light,
    shadowTexel: lightMatrices(light, SHADOW_MAP_SIZE),
    time: 0,
  };
  fakes.compiled.length = 0;
  const pipeline = await createPipeline({} as never, scene, [640, 360], 'bgra8unorm', view);
  return { pipeline, scene, simulation };
}

test('every pipeline is compiled before first use, the present pass for the output format', async () => {
  const { pipeline } = await build();
  const shadow = pipeline.shadow as unknown as Record<string, unknown>;
  const sceneColor = pipeline.scene as unknown as Record<string, unknown>;
  expect(shadow).toMatchObject({ size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE], depth: 'depth32float' });
  expect(sceneColor).toMatchObject({ size: [640, 360], format: 'rgba8unorm', depth: true, msaa: true });
  const against = new Map(fakes.compiled.map(({ label, against }) => [label, against]));
  for (const mesh of MESHES) {
    expect(against.get(`marble-machine.${mesh}`)).toBe(pipeline.scene);
    expect(against.get(`marble-machine.${mesh}-shadow`)).toBe(pipeline.shadow);
  }
  expect(against.get('marble-machine.backdrop')).toBe(pipeline.scene);
  expect(against.get('present')).toEqual({ colors: ['bgra8unorm'] });
  expect(fakes.compiled).toHaveLength(MESHES.length * 2 + 2);
});

test('lit and shadow shaders read the instance look the scene bridge streams', async () => {
  const { pipeline } = await build();
  for (const mesh of MESHES) {
    for (const drawn of [pipeline.lit[mesh], pipeline.casters[mesh]]) {
      const { shader } = drawn as unknown as { shader: { wgsl: string } };
      expect(shader.wgsl).toMatch(/@location\(7\)\s+look\s*:\s*vec4f/);
    }
  }
});

test('resize only touches the scene target when the size changes, and rebinds it', async () => {
  const { pipeline } = await build();
  const sceneColor = pipeline.scene as unknown as { resize: ReturnType<typeof vi.fn> };
  const present = pipeline.present as unknown as { set: ReturnType<typeof vi.fn> };
  present.set.mockClear();
  resizePipeline(pipeline, [640, 360]);
  expect(sceneColor.resize).not.toHaveBeenCalled();
  resizePipeline(pipeline, [800, 450]);
  expect(sceneColor.resize).toHaveBeenCalledWith([800, 450]);
  expect(present.set).toHaveBeenCalledWith({ sceneColor: pipeline.scene });
});

test('encode draws shadow, scene and present passes and skips meshes with no instances', async () => {
  const { pipeline, scene, simulation } = await build();
  publish(pipeline);
  // No marbles yet: parts and trims draw, the marble draws are skipped.
  expect(pipeline.counts.marbles).toBe(0);
  expect(pipeline.counts.parts).toBeGreaterThan(0);
  const passes: Array<{ target: unknown; draws: Array<[unknown, unknown]> }> = [];
  const currentFrame = {
    pass: vi.fn((options: { target: unknown }, body: (pass: { draw: (drawn: unknown, opts?: unknown) => void }) => void) => {
      const record = { target: options.target, draws: [] as Array<[unknown, unknown]> };
      passes.push(record);
      body({ draw: (drawn, opts) => record.draws.push([drawn, opts]) });
    }),
  };
  const output = { size: [640, 360] };
  encode(currentFrame as never, pipeline, output as never);
  expect(passes.map((pass) => pass.target)).toEqual([pipeline.shadow, pipeline.scene, output]);
  expect(passes[0]!.draws.map(([drawn]) => drawn)).toEqual([pipeline.casters.parts, pipeline.casters.trims]);
  expect(passes[1]!.draws.map(([drawn]) => drawn)).toEqual([pipeline.backdrop, pipeline.lit.parts, pipeline.lit.trims]);
  expect(passes[1]!.draws[1]![1]).toEqual({ instances: pipeline.counts.parts });
  expect(passes[2]!.draws).toEqual([[pipeline.present, undefined]]);

  // Once the scene carries a marble, the next publish draws it in both passes.
  simulation.release();
  syncMarbles(scene, simulation);
  publish(pipeline);
  passes.length = 0;
  encode(currentFrame as never, pipeline, output as never);
  expect(passes[0]!.draws.at(-1)).toEqual([pipeline.casters.marbles, { instances: 1 }]);
  expect(passes[1]!.draws.at(-1)).toEqual([pipeline.lit.marbles, { instances: 1 }]);
});
