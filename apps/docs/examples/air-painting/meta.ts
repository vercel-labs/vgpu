import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'air-painting',
  title: 'Air Painting',
  // One or two sentences, like every other example. The interop and privacy
  // story is documented in the /ml section, not crammed in here.
  description:
    'Wipe fog off the glass with your hands. ONNX Runtime Web tracks both palms on WebGPU to clear a frosted camera feed.',
  tags: ['machine-learning', 'onnx', 'hand-tracking', 'frosted-glass', 'shader'],
  capabilities: [
    'webgpu',
    'machine-learning',
    'external-device',
    'zero-copy',
    'gpu-buffer-interop',
    'storage-buffers',
    'compute-shader',
    'camera-input',
    'textures',
    'continuous-rendering',
    'responsive-canvas',
  ],
  // The thumbnail frosts a procedural stand-in frame and wipes it with the 24
  // golden landmark buffers, through the production shaders at a fixed dt. No
  // ORT, webcam or network, and nothing depending on wall-clock time.
  thumb: {
    warmupFrames: 1,
    dt: 1 / 30,
    note: 'Procedural frame frosted and wiped by the golden two-handed [1,63] landmark trajectory through the real frost/hand/paint/composite shaders; no ORT in the Node path.',
  },
  files: [
    'index.tsx',
    'renderer.ts',
    'ort-runtime.ts',
    'visual-pipeline.ts',
    'inference-scheduler.ts',
    'camera-source.ts',
    'hand-model-contract.ts',
    'hand-pipeline.ts',
    'hand-tracker.ts',
    'hand-preprocess.ts',
    'brush-contract.ts',
    'fixtures.ts',
    'hand-crop.wgsl',
    'hand.wgsl',
    'paint.wgsl',
    'composite.wgsl',
    'frost.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
