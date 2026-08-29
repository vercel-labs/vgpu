// Applies bloom, ACES tone mapping, vignette, and deterministic grain.

import { pcg2d, unitFloat } from "@vgpu/wgsl-std/hash";

@group(0) @binding(0) var beauty: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct FragmentIn {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

fn rrtAndOdtFit(value: vec3f) -> vec3f {
  let a = value * (value + vec3f(0.0245786)) - vec3f(0.000090537);
  let b = value * (vec3f(0.983729) * value + vec3f(0.4329510)) + vec3f(0.238081);
  return a / b;
}

fn acesFilmicToneMapping(value: vec3f) -> vec3f {
  let acesInput = mat3x3f(
    vec3f(0.59719, 0.07600, 0.02840),
    vec3f(0.35458, 0.90834, 0.13383),
    vec3f(0.04823, 0.01566, 0.83777),
  );
  let acesOutput = mat3x3f(
    vec3f(1.60475, -0.10208, -0.00327),
    vec3f(-0.53108, 1.10813, -0.07276),
    vec3f(-0.07367, -0.00605, 1.07602),
  );

  let transformed = acesInput * (value / 0.6);
  return acesOutput * rrtAndOdtFit(transformed);
}

@fragment
fn fs_main(input: FragmentIn) -> @location(0) vec4f {
  let scene = textureSampleLevel(beauty, samp, input.uv, 0.0).rgb;
  let glow = textureSampleLevel(bloom, samp, input.uv, 0.0).rgb;
  var color = (scene + glow * 1.8) * 1.05;

  let falloff = smoothstep(0.5, 1.0, length(input.uv - vec2f(0.5)) * 1.6);
  color = color * (1.0 - falloff * 0.45);

  color = acesFilmicToneMapping(color);
  var display = pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));

  let hashed = pcg2d(vec2u(input.position.xy));
  display = display + vec3f((unitFloat(hashed.x) - 0.5) * 0.018);

  return vec4f(clamp(display, vec3f(0.0), vec3f(1.0)), 1.0);
}
