export const meta = {
  slug: 'video-to-texture',
  title: 'Video to Texture',
  description:
    'Drive a texture from a playing video with requestVideoFrameCallback, so a copy into the GPU happens once per decoded frame while the cube keeps spinning at the display refresh rate.',
  tags: ['video', 'animation', '3d', 'rendering'],
  capabilities: [
    'webgpu',
    'textures',
    'video-input',
    'continuous-rendering',
    'responsive-canvas',
  ],
  files: [
    'index.tsx',
    'renderer.ts',
    'video-source.ts',
    'scene.ts',
    'cube.wgsl',
    'provenance.md',
  ],
} as const;
