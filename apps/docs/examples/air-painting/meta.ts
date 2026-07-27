import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'air-painting',
  title: 'Air Painting',
  description:
    "Paint with your wrist. ONNX Runtime Web runs MoveNet SinglePose Lightning on WebGPU, vgpu adopts ORT's device, and WGSL smooths, unletterboxes and paints the 17 GPU-resident keypoints through a non-owning zero-copy wrapper. A fixed 8x8 Bayer dither covers everything except the strokes, which reveal the raw camera.",
  tags: ['machine-learning', 'onnx', 'pose-estimation', 'ordered-dithering', 'shader'],
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
  // The thumbnail replays the canned frame and the 24 golden keypoint buffers
  // through the production shaders at a fixed dt. No ORT, webcam or network is
  // involved, and nothing about it depends on wall-clock time.
  thumb: {
    warmupFrames: 1,
    dt: 1 / 30,
    note: 'Canned frame + golden [1,1,17,3] trajectory through the real wrist/paint/composite shaders; no ORT in the Node path.',
  },
  files: [
    'index.tsx',
    'renderer.ts',
    'ort-runtime.ts',
    'demo-runtime.ts',
    'visual-pipeline.ts',
    'inference-scheduler.ts',
    'camera-source.ts',
    'preprocess.ts',
    'pose-contract.ts',
    'fixtures.ts',
    'wrist.wgsl',
    'paint.wgsl',
    'composite.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
