import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'depth-estimation',
  title: 'Depth Estimation',
  description:
    'Estimate depth from a photo or webcam with ONNX Runtime Web on WebGPU. Shade its GPU-resident output beside the input through a zero-copy vgpu buffer wrap.',
  tags: ['machine-learning', 'onnx', 'depth-estimation', 'shader'],
  capabilities: [
    'webgpu',
    'machine-learning',
    'external-device',
    'zero-copy',
    'gpu-buffer-interop',
    'storage-buffers',
    'compute-shader',
    'camera-input',
    'select-control',
    'demand-rendering',
    'responsive-canvas',
  ],
  // The thumbnail draws a committed depth capture; no model and no time dependence.
  thumb: { warmupFrames: 1, dt: 0, note: 'Deterministic fixture capture; no ORT in the Node path.' },
  files: [
    'index.tsx',
    'renderer.ts',
    'ort-runtime.ts',
    'model-contract.ts',
    'preprocess.ts',
    'inference-pump.ts',
    'model-switch.ts',
    'side-by-side.wgsl',
    'reduce-range.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
