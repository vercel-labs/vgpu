// Fixed constants + the runtime-tweakable spectrum parameters (as a uniform
// struct, so the lil-gui panel can drive the wave physics live). Pure module.

export const PI: f32 = 3.14159265359;
export const TWO_PI: f32 = 6.28318530718;

// FFT grid resolution. LOG2N must equal log2(N). Array<...> sizes elsewhere use
// the literal 256 (WGSL wants a const-expression there).
export const N: u32 = 256u;
export const LOG2N: u32 = 8u;

export const GRAVITY: f32 = 9.81;

// Driven from JS (see scene.ts / lil-gui). Shared by spectrum-init & -update.
export struct SimParams {
  windDir: vec2f,   // normalized wind direction
  windSpeed: f32,   // m/s — sets the largest wind-driven wavelength
  amplitude: f32,   // Phillips amplitude
  patchSize: f32,       // physical size (m) of one FFT tile
  time: f32,        // seconds
  _pad: vec2f,
}
