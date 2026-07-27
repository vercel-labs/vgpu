import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'air-painting',
  title: 'Air Painting',
  // One or two sentences, like every other example. The interop and privacy
  // story is documented in the /ml section, not crammed in here.
  description:
    'Wipe fog off the glass with your hands. ONNX Runtime Web runs MoveNet on WebGPU and vgpu reads the GPU-resident keypoints zero-copy, so both hands clear a frosted camera feed that slowly fogs back up.',
  tags: ['machine-learning', 'onnx', 'pose-estimation', 'frosted-glass', 'shader'],
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
  // golden keypoint buffers, through the production shaders at a fixed dt. No
  // ORT, webcam or network, and nothing depending on wall-clock time.
  thumb: {
    warmupFrames: 1,
    dt: 1 / 30,
    note: 'Procedural frame frosted and wiped by the golden two-handed [1,1,17,3] trajectory through the real frost/wrist/paint/composite shaders; no ORT in the Node path.',
  },
  files: [
    'index.tsx',
    'renderer.ts',
    'ort-runtime.ts',
    'visual-pipeline.ts',
    'inference-scheduler.ts',
    'camera-source.ts',
    'preprocess.ts',
    'pose-contract.ts',
    'fixtures.ts',
    'wrist.wgsl',
    'paint.wgsl',
    'composite.wgsl',
    'frost.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
