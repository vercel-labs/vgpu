// Final grade: bloom add, exposure, vignette, ACES filmic tone mapping, film grain, gamma.
//
// This pass combines bloom, vignette, and film grain. The grain is hashed from
// integer pixel coordinates rather than
// seeded from time, so a given frame is reproducible: the docs thumbnail pipeline
// diffs PNGs and per-frame random noise would never match.

import { pcg2d, unitFloat } from "@vgpu/wgsl-std/hash";

struct Composite {
  bloomStrength: f32,
  exposure: f32,
  vignetteStart: f32,
  vignetteDarkness: f32,
  grain: f32,
};

@group(0) @binding(0) var beauty: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> composite: Composite;

struct FragmentIn {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

// ACES filmic tone mapping uses Stephen Hill's fit rather than a
// per-channel curve. The input/output transforms are what let a hot orange light
// desaturate toward white instead of clipping to flat yellow.
fn rrtAndOdtFit(value: vec3f) -> vec3f {
  let a = value * (value + vec3f(0.0245786)) - vec3f(0.000090537);
  let b = value * (vec3f(0.983729) * value + vec3f(0.4329510)) + vec3f(0.238081);
  return a / b;
}

fn acesFilmicToneMapping(value: vec3f) -> vec3f {
  // Matrix constructors take columns, matching the ACES input and output transforms.
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

  // The 0.6 pre-scale preserves the ACES filmic response.
  let transformed = acesInput * (value / 0.6);
  return acesOutput * rrtAndOdtFit(transformed);
}

@fragment
fn fs_main(input: FragmentIn) -> @location(0) vec4f {
  let scene = textureSampleLevel(beauty, samp, input.uv, 0.0).rgb;
  let glow = textureSampleLevel(bloom, samp, input.uv, 0.0).rgb;
  var color = (scene + glow * composite.bloomStrength) * composite.exposure;

  // Vignette: `length(uv - 0.5)` is 0.707 in the corners for any aspect ratio, so
  // scaling by 1.6 puts the frame edge near 1 and the ramp stays framing-agnostic.
  let falloff = smoothstep(composite.vignetteStart, 1.0, length(input.uv - vec2f(0.5)) * 1.6);
  color = color * (1.0 - falloff * composite.vignetteDarkness);

  color = acesFilmicToneMapping(color);
  var display = pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));

  // Deterministic film grain, hashed from integer pixel coordinates. Applied after
  // the transfer curve so it stays a uniform amplitude instead of exploding in the
  // shadows the way pre-gamma noise does.
  let hashed = pcg2d(vec2u(input.position.xy));
  display = display + vec3f((unitFloat(hashed.x) - 0.5) * composite.grain);

  return vec4f(clamp(display, vec3f(0.0), vec3f(1.0)), 1.0);
}
