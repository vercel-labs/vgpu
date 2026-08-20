// Additive rasterization of the deterministic CPU ray bundle as a world-space
// sheet halfway through the prism's depth.
//
// Neighbouring wavelength rails form continuous spectral cells. Color is
// evaluated at their vertices, then interpolated by rasterization; the fragment
// stage only applies intensity and the white input beam's edge profile.

import { Scene } from "./scene.wgsl";

fn cieX(wavelength: f32) -> f32 {
  let t1 = (wavelength - 442.0) * select(0.0374, 0.0624, wavelength < 442.0);
  let t2 = (wavelength - 599.8) * select(0.0323, 0.0264, wavelength < 599.8);
  let t3 = (wavelength - 501.1) * select(0.0382, 0.0490, wavelength < 501.1);
  return 0.362 * exp(-0.5 * t1 * t1)
    + 1.056 * exp(-0.5 * t2 * t2)
    - 0.065 * exp(-0.5 * t3 * t3);
}

fn cieY(wavelength: f32) -> f32 {
  let t1 = (wavelength - 568.8) * select(0.0247, 0.0213, wavelength < 568.8);
  let t2 = (wavelength - 530.9) * select(0.0322, 0.0613, wavelength < 530.9);
  return 0.821 * exp(-0.5 * t1 * t1) + 0.286 * exp(-0.5 * t2 * t2);
}

fn cieZ(wavelength: f32) -> f32 {
  let t1 = (wavelength - 437.0) * select(0.0278, 0.0845, wavelength < 437.0);
  let t2 = (wavelength - 459.0) * select(0.0725, 0.0385, wavelength < 459.0);
  return 1.217 * exp(-0.5 * t1 * t1) + 0.681 * exp(-0.5 * t2 * t2);
}

fn wavelengthToLinearRgb(wavelength: f32) -> vec3f {
  let xyz = vec3f(cieX(wavelength), cieY(wavelength), cieZ(wavelength));
  return max(
    vec3f(
      3.2406 * xyz.x - 1.5372 * xyz.y - 0.4986 * xyz.z,
      -0.9689 * xyz.x + 1.8758 * xyz.y + 0.0415 * xyz.z,
      0.0557 * xyz.x - 0.2040 * xyz.y + 1.0570 * xyz.z,
    ),
    vec3f(0.0),
  );
}

@group(0) @binding(0) var<uniform> scene: Scene;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
  @location(1) profile: f32,
  @location(2) intensity: f32,
  @location(3) travel: f32,
};

@vertex
fn vs_main(
  @location(0) position: vec2f,
  @location(1) wavelength: f32,
  @location(2) profile: f32,
  @location(3) intensity: f32,
  @location(4) travel: f32,
) -> VertexOut {
  var out: VertexOut;
  out.position = scene.viewProjection * vec4f(position, scene.lightPlaneZ, 1.0);
  let spectral = wavelengthToLinearRgb(max(wavelength, 400.0));
  out.color = select(spectral, vec3f(1.0), wavelength < 0.0);
  out.profile = profile;
  out.intensity = intensity;
  out.travel = travel;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let radius = abs(in.profile);
  let radialFalloff = exp(-scene.lightEdgeFalloff * radius * radius)
    * (1.0 - smoothstep(0.55, 1.0, radius));
  let longitudinalFalloff = exp(-scene.rainbowFalloff * in.travel)
    * (1.0 - smoothstep(0.55, 0.95, in.travel));
  return vec4f(
    in.color * in.intensity * radialFalloff * longitudinalFalloff,
    0.0,
  );
}
