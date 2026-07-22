export const meta = {
  slug: 'fft-ocean',
  title: 'FFT Ocean',
  description: 'A deep-water surface driven by a real inverse FFT — a Phillips spectrum evolves in frequency space, Stockham passes bring it back to a displacement field, and half a million particles ride the waves through an HDR bloom chain.',
  thumb: { warmupFrames: 1, time: 18 },
  files: [
    'example.ts', 'ocean-graph.ts', 'camera.ts',
    'ocean-common.wgsl', 'noise.wgsl', 'initial-spectrum.wgsl', 'spectrum.wgsl', 'ifft-stage.wgsl', 'normal-foam.wgsl',
    'particles.wgsl', 'particles-common.wgsl', 'particles-light.wgsl',
    'bloom-bright.wgsl', 'bloom-blur.wgsl', 'bloom-composite.wgsl', 'present.wgsl', 'stage-preview.wgsl',
  ],
} as const;
