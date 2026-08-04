import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'mnist-classifier',
  title: 'MNIST Classifier',
  description:
    "Draw a digit and classify it with ONNX Runtime Web on WebGPU. Render the GPU-resident logits through a non-owning vgpu buffer wrap.",
  tags: ['machine-learning', 'onnx', 'mnist', 'shader'],
  capabilities: [
    'webgpu',
    'machine-learning',
    'external-device',
    'zero-copy',
    'gpu-buffer-interop',
    'storage-buffers',
    'pointer-input',
    'demand-rendering',
    'responsive-canvas',
  ],
  // The thumbnail renders the seeded digit and golden logits; no time dependence.
  thumb: { warmupFrames: 1, dt: 0, note: 'Deterministic fixture logits; no ORT in the Node path.' },
  files: [
    'index.tsx',
    'renderer.ts',
    'ort-runtime.ts',
    'preprocess.ts',
    'fixtures.ts',
    'visualize.wgsl',
  ],
} as const satisfies ExampleMetaDefinition;
