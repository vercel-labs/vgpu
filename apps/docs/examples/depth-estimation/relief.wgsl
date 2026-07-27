// Reads the depth tensor ONNX Runtime Web left on the GPU and lights it as a
// relief surface.
//
// The tensor is bound exactly as the model wrote it: a flat row-major
// `array<f32>`, no transpose, no repack, no copy into a texture. Everything
// here — the normalization, the surface normals, the contours — is derived from
// that one buffer inside the fragment shader.
//
// A flat colour ramp would be the easy read, and also a lie about what depth
// is: a rainbow heatmap makes every surface look equally flat. Instead the
// depth field is treated as a height field, lit from one direction, and banded
// with contour lines, so the geometry of the room is what you actually see.
//
// Palette is the docs gray scale plus the single blue accent, no gradients.

struct Uniforms {
  /// Framebuffer size in pixels.
  resolution: vec2f,
  /// Depth tensor size in texels (width, height).
  depth_size: vec2f,
  /// 0 = fixed logarithmic metric range, 1 = per-frame min/max range.
  mode: f32,
  /// Metric range endpoints, used when `mode` is 0.
  near_meters: f32,
  far_meters: f32,
  /// 1.0 once a real inference is bound, 0.0 while idle.
  has_result: f32,
  /// Parallax offset in [-1,1], driven by the pointer.
  parallax: vec2f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> depth: array<f32>;
/// Min/max keys from `reduce-range.wgsl`; only read when `mode` is 1.
@group(0) @binding(2) var<storage, read> range: array<u32>;

const BG: vec3f = vec3f(0.039, 0.039, 0.039);       // #0a0a0a  gray-1
const SURFACE: vec3f = vec3f(0.098, 0.098, 0.098);  // #191919  gray-3
const FAR: vec3f = vec3f(0.133, 0.133, 0.133);      // #222222  gray-4
const NEAR: vec3f = vec3f(0.451, 0.451, 0.451);     // #737373  gray-10
const ACCENT: vec3f = vec3f(0.000, 0.439, 0.953);   // #0070f3  blue-9
const RIM: vec3f = vec3f(0.059, 0.204, 0.376);      // #0f3460  blue-4

/// Contour bands across the full nearness range.
const CONTOURS: f32 = 12.0;

/// Inverse of `key_of` in reduce-range.wgsl.
fn value_of(key: u32) -> f32 {
  let mask = select(0xFFFFFFFFu, 0x80000000u, (key & 0x80000000u) != 0u);
  return bitcast<f32>(key ^ mask);
}

fn depth_at(texel: vec2i) -> f32 {
  let size = vec2i(uniforms.depth_size);
  let clamped = clamp(texel, vec2i(0, 0), size - vec2i(1, 1));
  return depth[u32(clamped.y * size.x + clamped.x)];
}

/// The one presentation contract: raw model output in, nearness in [0,1] out,
/// 1 = closest to the camera. Mirrors `nearnessFor()` in model-contract.ts.
fn nearness(value: f32) -> f32 {
  if (uniforms.mode < 0.5) {
    // Metric metres on a fixed log range. Fixed, so the picture cannot pump
    // between frames as the scene changes.
    let near_m = max(uniforms.near_meters, 1e-4);
    let span = log(max(uniforms.far_meters, near_m * 1.001) / near_m);
    let scaled = log(max(value, near_m) / near_m) / span;
    return 1.0 - clamp(scaled, 0.0, 1.0);
  }
  // Relative inverse depth: rescale by this frame's own range.
  let lo = value_of(range[0]);
  let hi = value_of(range[1]);
  let span = hi - lo;
  if (span <= 1e-9) { return 0.0; }
  return clamp((value - lo) / span, 0.0, 1.0);
}

fn nearness_at(texel: vec2i) -> f32 {
  return nearness(depth_at(texel));
}

@fragment
fn main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;

  // Cover-fit the depth map into the canvas so the aspect ratio never stretches.
  let canvas_aspect = uniforms.resolution.x / uniforms.resolution.y;
  let depth_aspect = uniforms.depth_size.x / uniforms.depth_size.y;
  var fitted = uv;
  if (canvas_aspect > depth_aspect) {
    let scale = depth_aspect / canvas_aspect;
    fitted.y = (uv.y - 0.5) / scale + 0.5;
  } else {
    let scale = canvas_aspect / depth_aspect;
    fitted.x = (uv.x - 0.5) / scale + 0.5;
  }

  if (uniforms.has_result < 0.5) {
    return vec4f(BG, 1.0);
  }

  // Single-step parallax: shift the lookup by the pointer, scaled by how near
  // the surface under the cursor is, which makes foreground objects slide over
  // the background as you move.
  let probe = nearness_at(vec2i(fitted * uniforms.depth_size));
  let shifted = fitted + uniforms.parallax * (probe - 0.45) * 0.06;

  let texel = vec2i(shifted * uniforms.depth_size);
  if (shifted.x < 0.0 || shifted.x > 1.0 || shifted.y < 0.0 || shifted.y > 1.0) {
    return vec4f(BG, 1.0);
  }

  let n = nearness_at(texel);

  // Pseudo-normal from the nearness gradient. The z term sets how much relief
  // the lighting implies; it is in nearness units, not metres, on purpose —
  // the three models disagree about metres.
  let dx = nearness_at(texel + vec2i(1, 0)) - nearness_at(texel - vec2i(1, 0));
  let dy = nearness_at(texel + vec2i(0, 1)) - nearness_at(texel - vec2i(0, 1));
  let normal = normalize(vec3f(-dx * 6.0, -dy * 6.0, 0.35));

  let light = normalize(vec3f(-0.45, -0.7, 0.55));
  let diffuse = clamp(dot(normal, light), 0.0, 1.0);
  // Rim term picks out silhouettes: steep gradients are depth discontinuities,
  // which is exactly where one object ends and another begins.
  let steepness = clamp(length(vec2f(dx, dy)) * 7.0, 0.0, 1.0);

  // Base tone carries the depth ordering; near is lighter, far recedes to the
  // panel colour.
  var colour = mix(FAR, NEAR, n);
  colour = mix(colour, SURFACE, 0.25);
  colour = colour + ACCENT * diffuse * 0.22;
  colour = colour + RIM * steepness * 0.9;

  // Contour bands, antialiased in screen space so they stay hairlines at any
  // canvas size and vanish where the surface is flat.
  let bands = n * CONTOURS;
  let band_width = max(fwidth(bands), 1e-4);
  let line = 1.0 - smoothstep(0.0, band_width * 1.2, abs(fract(bands) - 0.5) - 0.5 + band_width * 1.2);
  colour = colour + vec3f(0.10, 0.12, 0.14) * line * (0.35 + 0.65 * steepness);

  // Vignette keeps the eye on the subject without adding a gradient wash.
  let edge = distance(uv, vec2f(0.5, 0.5));
  colour = colour * (1.0 - 0.35 * clamp(edge - 0.35, 0.0, 1.0));

  return vec4f(clamp(colour, vec3f(0.0), vec3f(1.0)), 1.0);
}
