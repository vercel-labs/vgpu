export const meta = {
  slug: 'atmosphere',
  title: 'Atmosphere',
  description: 'A physically based sky and volumetric clouds — Hillaire 2020 transmittance, multiple-scattering, sky-view and aerial-perspective lookup tables built with compute and storage textures, ozone, a limb-darkened sun, and Nubis-style clouds raymarched through tileable 3D Perlin-Worley noise and lit by the same tables, from sea level up to the stratosphere.',
  tags: ['volumetric', 'compute', 'raymarching', 'hdr'],
  capabilities: ['webgpu', 'compute-shader', 'multi-pass', 'continuous-rendering', 'responsive-canvas', 'textures'],
  thumb: { warmupFrames: 1, time: 0 },
  files: [
    'index.tsx', 'renderer.ts', 'tuning.ts', 'camera.ts', 'controls.ts',
    'atmosphere-common.wgsl', 'frame-constants.wgsl', 'transmittance-lut.wgsl', 'multiscatter-lut.wgsl', 'sky-view-lut.wgsl', 'aerial-lut.wgsl',
    'terrain.wgsl', 'terrain-heightmap.wgsl', 'terrain-depth.wgsl', 'terrain-sun-depth.wgsl', 'scene.wgsl', 'noise-common.wgsl', 'cloud-shape-noise.wgsl', 'cloud-detail-noise.wgsl', 'weather-map.wgsl',
    'curl-noise.wgsl', 'clouds-common.wgsl', 'clouds-temporal.wgsl', 'clouds-march.wgsl', 'clouds-resolve.wgsl', 'cloud-shadow.wgsl', 'present.wgsl', 'lut-preview.wgsl',
  ],
} as const;
