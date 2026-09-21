export const meta = {
  slug: 'black-hole',
  title: 'Black Hole',
  description:
    'Raymarched gravitational lensing — null geodesics bend starlight around an event horizon while a Keplerian accretion disk glows with Doppler beaming, graded through an HDR bloom chain.',
  tags: ['black-hole', 'raymarching', 'hdr', 'bloom'],
  capabilities: [
    'webgpu',
    'pointer-orbit',
    'multi-pass',
    'continuous-rendering',
    'responsive-canvas',
  ],
  thumb: { warmupFrames: 1, time: 8.5 },
  files: [
    'index.tsx',
    'renderer.ts',
    'pipeline.ts',
    'black-hole.wgsl',
    'bright-pass.wgsl',
    'blur.wgsl',
    'composite.wgsl',
  ],
} as const;
