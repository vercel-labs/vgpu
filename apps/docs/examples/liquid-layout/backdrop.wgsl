// The scene behind the glass, in linear HDR at CSS-pixel resolution: a deep
// navy/indigo room with a violet haze and a fine dot grid, crossed by thin
// luminous filaments like slow lightning. The filaments are the zero contours
// of two-octave simplex noise, bent by a slow warp and kinked by a fine one;
// branches are contours of a finer field that only show near a filament. Both
// are drawn one pixel wide from their screen-space derivative.
//
// rgb = the room with its filaments; a = filament intensity, so the glass can
// re-tint and brighten the filaments it refracts.

import { fbmSimplex3d, simplex2d, simplex3d } from "@vgpu/wgsl-std/noise/simplex";

struct Backdrop {
  viewport: vec2f,
  time: f32,
  dim: f32,
}

@group(0) @binding(0) var<uniform> backdrop: Backdrop;

const DOT_SPACING = 22.0;
const VEIN_SCALE = 320.0;
const BLUE = vec3f(0.22, 0.42, 1.0);
const VIOLET = vec3f(0.58, 0.32, 1.0);

fn room(uv: vec2f, p: vec2f, t: f32) -> vec3f {
  let aspect = backdrop.viewport.x / max(backdrop.viewport.y, 1.0);
  // Lighter toward the upper centre-left, falling off to a darker right side.
  let c = (uv - vec2f(0.4, 0.36)) * vec2f(aspect, 1.0);
  let glow = exp(-dot(c, c) * 1.4);
  var color = mix(vec3f(0.008, 0.011, 0.03), vec3f(0.02, 0.034, 0.078), glow);
  color *= mix(1.0, 0.7, smoothstep(0.55, 1.0, uv.x));
  let haze = fbmSimplex3d(vec3f(p / 560.0 + vec2f(3.1, 7.7), t * 0.02), 2, 2.0, 0.5);
  color += vec3f(0.018, 0.007, 0.036) * smoothstep(-0.15, 0.7, haze);

  // Dot grid with an anti-aliased edge.
  let local = (fract(p / DOT_SPACING) - 0.5) * DOT_SPACING;
  let spot = 1.0 - smoothstep(0.5, 1.3, length(local));
  color += vec3f(0.012, 0.016, 0.032) * spot;
  return color;
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * backdrop.viewport;
  let t = backdrop.time;

  // A slow warp bends the filaments; a fine, weak one kinks them like arcs.
  let q = p / VEIN_SCALE + vec2f(11.7, 3.2);
  let bend = vec2f(simplex3d(vec3f(q * 0.7, t * 0.03)), simplex3d(vec3f(q * 0.7 + 17.3, t * 0.03 + 5.0)));
  let kink = vec2f(simplex2d(q * 7.0 + vec2f(3.1, 0.4)), simplex2d(q * 7.0 + vec2f(8.7, 5.2)));
  let wq = q + bend * 0.3 + kink * 0.03;
  let trunk = simplex2d(wq) + 0.3 * simplex2d(wq * 2.6 + vec2f(1.7, 4.4));
  let branch = simplex2d(wq * 2.3 + vec2f(5.1, 9.4)) + 0.3 * simplex2d(wq * 6.1 + vec2f(2.3, 7.9));
  // Derivatives stay at the top level: fwidth needs uniform control flow.
  let trunkPx = abs(trunk) / max(fwidth(trunk), 1e-5);
  let branchPx = abs(branch) / max(fwidth(branch), 1e-5);

  // A thin hot core inside a wide soft glow.
  let core = 0.8 * exp(-trunkPx * trunkPx / 1.2) + 0.3 * exp(-trunkPx / 9.0);
  let twig = (0.7 * exp(-branchPx * branchPx / 0.8) + 0.2 * exp(-branchPx / 6.0)) * exp(-trunkPx / 22.0);
  // Filaments fade in and out along their length and cluster in parts of the frame.
  let region = smoothstep(-0.2, 0.6, simplex3d(vec3f(p / 520.0 + vec2f(40.0, 2.0), t * 0.012)));
  let pulse = 0.5 + 0.5 * simplex3d(vec3f(wq * 1.4, t * 0.05 + 9.0));
  let vein = (core + 0.75 * twig) * region * max(pulse, 0.0);
  let hue = smoothstep(-0.4, 0.4, simplex3d(vec3f(p / 900.0 + vec2f(-7.0, 21.0), t * 0.01)));
  let veinColor = mix(BLUE, VIOLET, hue) * vein * 0.16;

  let fade = mix(1.0, 0.45, backdrop.dim);
  return vec4f((room(uv, p, t) + veinColor) * fade, vein * fade);
}
