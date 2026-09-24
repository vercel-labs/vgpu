// The scene behind the glass, in linear HDR at CSS-pixel resolution: a deep
// navy gradient, slow aurora ribbons and a fine dot lattice. The lattice is
// there for the refraction: seen through the liquid, it bends and magnifies.

import { fbmSimplex3d } from "@vgpu/wgsl-std/noise/simplex";

struct Backdrop {
  viewport: vec2f,
  time: f32,
  dim: f32,
}

@group(0) @binding(0) var<uniform> backdrop: Backdrop;

const DOT_SPACING = 26.0;

fn aurora(p: vec2f, t: f32) -> vec3f {
  let scale = 1.0 / max(backdrop.viewport.y, 1.0);
  let q = p * scale;
  let flow = fbmSimplex3d(vec3f(q * vec2f(1.1, 1.8), t * 0.035), 4, 2.0, 0.5);
  let ribbon = fbmSimplex3d(vec3f(q * vec2f(0.7, 2.6) + vec2f(flow * 0.35, 0.0), t * 0.05 + 3.0), 3, 2.0, 0.5);
  let band = smoothstep(0.05, 0.75, ribbon * 0.5 + 0.5);
  let aspect = backdrop.viewport.x * scale;
  let x = q.x / max(aspect, 0.001);
  let azure = vec3f(0.02, 0.16, 0.42);
  let violet = vec3f(0.16, 0.05, 0.36);
  let magenta = vec3f(0.36, 0.03, 0.2);
  let hue = mix(mix(azure, violet, smoothstep(0.1, 0.6, x)), magenta, smoothstep(0.55, 1.0, x + flow * 0.2));
  // Brighter at the top, fading toward the floor of the frame.
  let height = mix(1.0, 0.35, smoothstep(0.0, 1.0, q.y));
  return hue * band * height * 0.55;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * backdrop.viewport;
  let base = mix(vec3f(0.011, 0.016, 0.04), vec3f(0.003, 0.004, 0.012), smoothstep(0.0, 1.0, uv.y));
  var color = base + aurora(p, backdrop.time);

  // Dot lattice with a one-pixel anti-aliased edge.
  let cell = p / DOT_SPACING;
  let local = (fract(cell) - 0.5) * DOT_SPACING;
  let spot = 1.0 - smoothstep(0.7, 1.7, length(local));
  // Every fourth line is brighter, which gives the refraction something to bend.
  let major = select(0.0, 1.0, all(abs(fract(floor(cell) / 4.0)) < vec2f(0.01)));
  color += vec3f(0.55, 0.62, 0.85) * spot * (0.035 + 0.06 * major);

  // Soft light pool under the grid so the glass has something bright to refract.
  let centre = (uv - vec2f(0.5, 0.52)) * vec2f(backdrop.viewport.x / max(backdrop.viewport.y, 1.0), 1.0);
  color += vec3f(0.05, 0.06, 0.12) * exp(-dot(centre, centre) * 3.0);

  return vec4f(color * mix(1.0, 0.45, backdrop.dim), 1.0);
}
