// Additive rasterization of the deterministic CPU ray bundle.
//
// Each quad carries one wavelength color and a signed transverse coordinate.
// The fragment stage only supplies the smooth beam profile; all bending,
// topology, Fresnel loss and energy-density compensation were solved when the
// vertices were built.

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
  @location(0) wavelength: f32,
  @location(1) profile: f32,
  @location(2) intensity: f32,
};

@vertex
fn vs_main(
  @location(0) position: vec2f,
  @location(1) wavelength: f32,
  @location(2) profile: f32,
  @location(3) intensity: f32,
) -> VertexOut {
  var out: VertexOut;
  out.position = scene.viewProjection * vec4f(position, 0.0, 1.0);
  out.wavelength = wavelength;
  out.profile = profile;
  out.intensity = intensity;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let edge = 1.0 - smoothstep(0.72, 1.0, abs(in.profile));
  let spectral = wavelengthToLinearRgb(max(in.wavelength, 400.0));
  let color = select(spectral, vec3f(1.0), in.wavelength < 0.0);
  return vec4f(color * in.intensity * edge, 0.0);
}
