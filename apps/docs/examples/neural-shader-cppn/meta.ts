import type { ExampleMetaDefinition } from '../../lib/example-meta';

export const meta = {
  slug: 'neural-shader-cppn',
  title: 'Neural Shader (CPPN)',
  description:
    'Run a tiny ONNX network over a 256x256 coordinate grid every frame with ONNX Runtime Web, and draw its GPU-resident output through a zero-copy vgpu buffer wrap.',
  tags: ['machine-learning', 'onnx', 'cppn', 'neural-shader', 'animation', 'shader'],
  capabilities: [
    'webgpu',
    'machine-learning',
    'external-device',
    'zero-copy',
    'storage-buffers',
    'fragment-shader',
    'continuous-rendering',
    'responsive-canvas',
  ],
  // Fixed time so the CPU thumbnail is byte-stable; dt 0 keeps it single-shot.
  thumb: { time: 2.75, warmupFrames: 1, dt: 0 },
  files: [
    'index.tsx',
    'renderer.ts',
    'ort-runtime.ts',
    'evaluate.ts',
    'frame-pump.ts',
    'present.wgsl',
    'generate-model.mjs',
  ],
} as const satisfies ExampleMetaDefinition;
