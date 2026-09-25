// The frame: a dark tabletop with a faint dot grid under luminous ink, the
// orb's soft shadow and focused caustic on it, and the orb itself drawn as a
// glass dome over that surface: Snell refraction per colour channel, a
// Fresnel blend with a studio reflection, a crisp highlight and a dark
// silhouette line. Everything is in linear light until the sRGB encode.

import { linearToSrgb3 } from "@vgpu/wgsl-std/color";
import { pcg2d } from "@vgpu/wgsl-std/hash";

struct View {
  // Output size in physical pixels.
  size: vec2f,
  dyeTexel: vec2f,
  // Orb centre and (squashed) radii in physical pixels.
  orbCenter: vec2f,
  orbRadii: vec2f,
  orbRadius: f32,
  // 0 resting on the ink .. 1 lifted by the press spring.
  lift: f32,
  refraction: f32,
  dispersion: f32,
  gridSpacing: f32,
  pixelRatio: f32,
  orbVisible: f32,
  inkGain: f32,
}

@group(0) @binding(0) var dye: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> view: View;

// Key light up and to the left of the screen (v points down).
const LIGHT = vec3f(-0.42, -0.56, 0.71);
const GLASS_TINT = vec3f(0.94, 0.975, 1.0);

fn tabletop(p: vec2f) -> vec3f {
  let uv = p / view.size;
  let centered = (uv - vec2f(0.5, 0.42)) * vec2f(view.size.x / view.size.y, 1.0);
  var base = mix(vec3f(0.020, 0.024, 0.040), vec3f(0.004, 0.005, 0.010), smoothstep(0.0, 1.15, length(centered)));
  let q = (fract(p / view.gridSpacing) - 0.5) * view.gridSpacing;
  let radius = 1.15 * view.pixelRatio;
  let dotMask = 1.0 - smoothstep(radius - 0.8, radius + 0.8, length(q));
  return base + vec3f(0.050, 0.058, 0.078) * dotMask;
}

fn ink_at(uv: vec2f) -> vec3f {
  return textureSampleLevel(dye, samp, uv, 0.0).rgb * view.inkGain;
}

// Compresses bright ink without washing it to white (a per-channel curve
// would), then lets only the densest ink run hot.
fn ink_tone(d: vec3f) -> vec3f {
  let peak = max(max(d.r, max(d.g, d.b)), 1e-4);
  let tone = d * ((1.0 - exp(-peak * 1.4)) / peak) * 1.1;
  return tone + vec3f(smoothstep(1.8, 4.0, peak) * 0.3);
}

fn thickness(d: vec3f) -> f32 {
  return dot(d, vec3f(0.3, 0.45, 0.25));
}

fn orb_shadow(p: vec2f) -> f32 {
  let away = -normalize(LIGHT.xy);
  let offset = away * view.orbRadius * (0.2 + 0.55 * view.lift);
  let rel = (p - view.orbCenter - offset) / (view.orbRadii * (1.0 + 0.2 * view.lift));
  let softness = 0.3 + 0.55 * view.lift;
  let cover = 1.0 - smoothstep(1.0 - softness, 1.0 + softness * 0.5, length(rel));
  return 1.0 - cover * (0.62 - 0.3 * view.lift) * view.orbVisible;
}

fn orb_caustic(p: vec2f) -> f32 {
  let away = -normalize(LIGHT.xy);
  let offset = away * view.orbRadius * (0.42 + 0.75 * view.lift);
  let rel = (p - view.orbCenter - offset) / view.orbRadii;
  let spread = 0.2 + 0.32 * view.lift;
  return exp(-dot(rel, rel) / (spread * spread)) * (0.95 / (1.0 + 2.5 * view.lift)) * view.orbVisible;
}

/** The lit fluid at a pixel, including the orb's shadow and caustic on it. */
fn surface(p: vec2f) -> vec3f {
  let uv = p / view.size;
  let d = ink_at(uv);
  let h = thickness(d);
  let hx = thickness(ink_at(uv + vec2f(view.dyeTexel.x, 0.0)));
  let hy = thickness(ink_at(uv + vec2f(0.0, view.dyeTexel.y)));
  let normal = normalize(vec3f(h - hx, h - hy, 0.16));
  let ink = ink_tone(d);
  let cover = saturate(max(ink.r, max(ink.g, ink.b)) * 1.2);
  var color = tabletop(p) * (1.0 - 0.75 * cover) + ink;
  let halfway = normalize(LIGHT + vec3f(0.0, 0.0, 1.0));
  color += vec3f(pow(max(dot(normal, halfway), 0.0), 70.0) * 0.45 * saturate(h * 1.5));
  color *= orb_shadow(p);
  color += orb_caustic(p) * (vec3f(1.0, 0.93, 0.82) * 0.22 + ink * 1.1);
  return color;
}

fn studio(dir: vec3f) -> vec3f {
  let sky = mix(vec3f(0.02, 0.022, 0.035), vec3f(0.22, 0.24, 0.3), saturate(0.5 - dir.y * 0.7));
  let box = abs(dir.xy - vec2f(-0.44, -0.5)) - vec2f(0.17, 0.1);
  let boxDistance = length(max(box, vec2f(0.0))) + min(max(box.x, box.y), 0.0) - 0.04;
  let softbox = 1.0 - smoothstep(-0.02, 0.05, boxDistance);
  let rim = smoothstep(0.35, 0.0, length(dir.xy - vec2f(0.62, 0.55)));
  return sky + softbox * vec3f(9.0, 8.8, 8.4) + rim * vec3f(0.6, 0.7, 0.9);
}

fn glass(p: vec2f, rel: vec2f, rr: f32) -> vec3f {
  let z = sqrt(max(1.0 - rr * rr, 0.0));
  let normal = vec3f(rel, z);
  let depth = z * view.orbRadii * view.refraction;
  let spread = 0.035 * view.dispersion;
  var refracted = vec3f(0.0);
  for (var channel = 0; channel < 3; channel++) {
    let ior = 1.5 + f32(channel - 1) * spread;
    let ray = refract(vec3f(0.0, 0.0, -1.0), normal, 1.0 / ior);
    let shift = ray.xy / max(-ray.z, 0.25) * depth;
    refracted[channel] = surface(p + shift)[channel];
  }
  refracted *= GLASS_TINT * (0.86 + 0.14 * z);

  let fresnel = 0.04 + 0.96 * pow(1.0 - z, 5.0);
  var color = mix(refracted, studio(reflect(vec3f(0.0, 0.0, -1.0), normal)), fresnel);
  let halfway = normalize(LIGHT + vec3f(0.0, 0.0, 1.0));
  let facing = max(dot(normal, halfway), 0.0);
  color += vec3f(pow(facing, 220.0) * 4.0 + pow(facing, 28.0) * 0.1);
  // Light that crossed the ball gathers on its far rim.
  let far = saturate(dot(rel, -normalize(LIGHT.xy)));
  color += vec3f(0.55, 0.6, 0.7) * smoothstep(0.5, 0.95, rr) * far * far * 0.7;
  color *= 1.0 - 0.6 * smoothstep(0.93, 1.0, rr);
  return color;
}

fn shoulder(c: vec3f) -> vec3f {
  let over = max(c - vec3f(0.8), vec3f(0.0));
  return min(c, vec3f(0.8)) + over / (vec3f(1.0) + over * 5.0);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * view.size;
  var color = surface(p);

  let rel = (p - view.orbCenter) / max(view.orbRadii, vec2f(1.0));
  let rr = length(rel);
  if (view.orbVisible > 0.0 && rr < 1.02) {
    let edge = saturate((1.0 - rr) * min(view.orbRadii.x, view.orbRadii.y) / 1.25 + 0.5);
    color = mix(color, glass(p, rel / max(rr, 1.0), min(rr, 1.0)), edge);
  }

  let vignette = 1.0 - 0.3 * smoothstep(0.5, 1.3, length((uv - 0.5) * 2.0));
  var encoded = linearToSrgb3(shoulder(color * vignette));
  let noise = pcg2d(vec2u(p));
  encoded += (f32(noise.x & 255u) / 255.0 - 0.5) / 255.0;
  return vec4f(encoded, 1.0);
}
