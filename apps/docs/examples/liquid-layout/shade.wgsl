// Lights the liquid at full resolution. The distance field gives a circular
// bevel profile and a normal. Through the normal, the glass refracts the
// backdrop with one tap per colour channel, absorbs light with a Beer-Lambert
// tint, reflects a studio environment with Fresnel, and catches a specular
// from the pointer-driven key light. Speed brings out moving caustics. The top
// layer (the open panel, a held card) refracts the already-lit grid beneath it.

import { simplex3d } from "@vgpu/wgsl-std/noise/simplex";

struct Shade {
  viewport: vec2f,
  fieldTexel: vec2f,
  light: vec3f,
  time: f32,
  dpr: f32,
  refraction: f32,
  dispersion: f32,
  bevel: f32,
  gridDim: f32,
  panelHue: f32,
  panelEnergy: f32,
  causticSpeed: f32,
  // Opacity of the top layer while a blob lifts into it or settles out of it.
  panelLift: f32,
}

@group(0) @binding(0) var fieldTex: texture_2d<f32>;
@group(0) @binding(1) var backdropTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> shade: Shade;

const AZURE = vec3f(0.16, 0.56, 1.0);
const VIOLET = vec3f(0.52, 0.3, 1.0);
const MAGENTA = vec3f(1.0, 0.2, 0.6);

fn tint(hue: f32) -> vec3f {
  let h = clamp(hue, 0.0, 1.0);
  return mix(mix(AZURE, VIOLET, smoothstep(0.0, 0.5, h)), MAGENTA, smoothstep(0.5, 1.0, h));
}

fn fieldAt(uv: vec2f) -> vec4f {
  return textureSampleLevel(fieldTex, samp, uv, 0.0);
}

fn backdropAt(uv: vec2f) -> vec3f {
  return textureSampleLevel(backdropTex, samp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
}

struct Taps {
  centre: vec4f,
  // Gradients in field units per CSS px: xy = grid, zw = panel.
  grad: vec4f,
}

fn taps(uv: vec2f) -> Taps {
  let step = shade.fieldTexel;
  let px = shade.fieldTexel * shade.viewport;
  let c = fieldAt(uv);
  let r = fieldAt(uv + vec2f(step.x, 0.0));
  let l = fieldAt(uv - vec2f(step.x, 0.0));
  let d = fieldAt(uv + vec2f(0.0, step.y));
  let u = fieldAt(uv - vec2f(0.0, step.y));
  let gx = (r.rg - l.rg) / (2.0 * px.x);
  let gy = (d.rg - u.rg) / (2.0 * px.y);
  return Taps(c, vec4f(gx.x, gy.x, gx.y, gy.y));
}

struct Bevel {
  normal: vec3f,
  // 0 at the rim, 1 once the bevel reaches full height.
  thickness: f32,
}

fn bevel(d: f32, grad: vec2f) -> Bevel {
  let q = clamp(-d / shade.bevel, 0.0, 1.0);
  let e = 1.0 - q;
  let height = sqrt(max(1.0 - e * e, 0.0));
  let slope = e / max(height, 0.14);
  let len = length(grad);
  let outward = select(vec2f(0.0), grad / len, len > 1e-4);
  return Bevel(normalize(vec3f(outward * slope, 1.0)), height);
}

fn environment(r: vec3f) -> vec3f {
  // A dim studio: a cool ceiling, a soft diagonal softbox and a warm kicker.
  let ceiling = mix(vec3f(0.012, 0.016, 0.034), vec3f(0.26, 0.32, 0.48), smoothstep(-0.1, 0.95, -r.y));
  let band = exp(-pow((r.x * 0.75 - r.y * 0.66 - 0.3) * 2.6, 2.0)) * 0.55;
  let kicker = exp(-pow((r.x * -0.9 - r.y * 0.4 - 0.55) * 3.5, 2.0)) * vec3f(1.0, 0.62, 0.4) * 0.3;
  return ceiling + vec3f(0.85, 0.92, 1.0) * band + kicker;
}

fn caustics(p: vec2f, t: f32) -> f32 {
  // Two slow, broad ridge fields: light focused by the moving surface.
  let a = 1.0 - abs(simplex3d(vec3f(p * 0.0055, t)));
  let b = 1.0 - abs(simplex3d(vec3f(p * 0.0085 + 7.3, t * 1.3 + 2.0)));
  return pow(a, 6.0) * 0.7 + pow(b, 8.0) * 0.4;
}

fn glass(p: vec2f, surface: Bevel, under: vec3f, hue: f32, energy: f32) -> vec3f {
  let n = surface.normal;
  let colour = tint(hue);
  // Beer-Lambert: thicker glass absorbs more of what its tint does not pass.
  let depth = 0.5 + 2.4 * surface.thickness;
  let transmit = exp(-(vec3f(1.0) - colour) * depth) * 0.82;
  var result = under * transmit;
  result += colour * (0.018 + 0.05 * energy) * surface.thickness;

  let view = vec3f(0.0, 0.0, 1.0);
  let fresnel = 0.04 + 0.96 * pow(1.0 - n.z, 5.0);
  result += environment(reflect(-view, n)) * fresnel * mix(vec3f(1.0), colour, 0.35);

  // Key light. The rim facing it catches a bright edge line and the far rim a
  // fainter internal reflection; under the light the glass glows softly in its tint.
  let toLight = shade.light.xy - p;
  let halfway = normalize(normalize(vec3f(toLight, shade.light.z)) + view);
  let facing = max(dot(n, halfway), 0.0);
  let rim = 1.0 - surface.thickness;
  let inner = surface.thickness * surface.thickness;
  let lateral = length(n.xy);
  let outward = select(vec2f(0.0), n.xy / lateral, lateral > 1e-4);
  let side = dot(outward, toLight / max(length(toLight), 1.0));
  let edge = pow(rim, 4.0);
  let white = vec3f(1.0, 0.97, 0.92);
  result += white * (pow(max(side, 0.0), 3.0) * 0.6 + pow(max(-side, 0.0), 3.0) * 0.16) * edge;
  result += white * pow(facing, 40.0) * 0.35 * rim * rim;
  result += colour * exp(-dot(toLight, toLight) / 51200.0) * 0.09 * surface.thickness;

  let glow = caustics(p, shade.time * shade.causticSpeed) * inner;
  result += (colour * 1.2 + 0.2) * glow * (0.06 + 0.26 * energy);
  return result;
}

fn coverage(d: f32) -> f32 {
  return clamp(0.5 - d * shade.dpr, 0.0, 1.0);
}

// The rim pulls in what lies just outside the edge, compressed, like a thick lens.
fn refractOffset(n: vec3f, strength: f32) -> vec2f {
  return n.xy * strength / shade.viewport;
}

// The lit grid layer at uv, including its shadow and light spill on the backdrop.
fn gridShade(uv: vec2f, t: Taps) -> vec3f {
  let p = uv * shade.viewport;
  let d = t.centre.r;

  // Soft contact shadow and coloured light passing through onto the floor.
  let shadowTap = fieldAt(uv - vec2f(0.0, 14.0) / shade.viewport);
  let shadow = (1.0 - smoothstep(-26.0, 46.0, shadowTap.r)) * 0.5;
  let spill = tint(shadowTap.b) * exp(-max(shadowTap.r, 0.0) / 12.0) * (0.035 + 0.08 * shadowTap.a);
  var outside = backdropAt(uv) * (1.0 - shadow) + spill * step(0.0, shadowTap.r);

  let cov = coverage(d);
  if (cov <= 0.0) {
    return outside * mix(1.0, 0.7, shade.gridDim);
  }
  let surface = bevel(d, t.grad.xy);
  let offset = refractOffset(surface.normal, shade.refraction * (1.0 + 0.4 * t.centre.a));
  let spread = shade.dispersion;
  let under = vec3f(
    backdropAt(uv + offset * (1.0 - spread)).r,
    backdropAt(uv + offset).g,
    backdropAt(uv + offset * (1.0 + spread)).b,
  );
  let lit = glass(p, surface, under, t.centre.b, t.centre.a);
  return mix(outside, lit, cov) * mix(1.0, 0.62, shade.gridDim);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * shade.viewport;
  let here = taps(uv);
  var color = gridShade(uv, here);

  let dp = here.centre.g;
  let lift = shade.panelLift;
  // The top layer's shadow falls wide and soft on the grid.
  let panelShadow = fieldAt(uv - vec2f(0.0, 26.0) / shade.viewport).g;
  color *= 1.0 - (1.0 - smoothstep(-20.0, 90.0, panelShadow)) * 0.6 * lift;

  let cov = coverage(dp) * lift;
  if (cov > 0.0) {
    let surface = bevel(dp, here.grad.zw);
    let offset = refractOffset(surface.normal, shade.refraction * 1.6);
    let seen = clamp(uv + offset, vec2f(0.0), vec2f(1.0));
    let under = gridShade(seen, taps(seen));
    let lit = glass(p, surface, under, shade.panelHue, shade.panelEnergy);
    color = mix(color, lit, cov);
  }
  return vec4f(max(color, vec3f(0.0)), 1.0);
}
