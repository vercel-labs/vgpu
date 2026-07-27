// Fixed compositor: dithered everywhere, raw camera where the wrist has painted.
//
// The default is deliberate. Starting from a stylized 8x8 Bayer treatment makes
// the idle state look finished, and the first stroke then *reveals reality*,
// which reads far better than painting dither onto a normal feed. There is no
// effect selector.
//
// FUNCTIONAL PLACEHOLDER. The bindings, the coordinate spaces and the
// `mask 1 = raw, mask 0 = dither` polarity are the frozen contract; the palette,
// feather, glow and cursor below are plain on purpose and belong to the VISUAL
// owner.
//
// Anchoring: the Bayer cell is measured in *logical* pixels (`cell` is already
// dpr-scaled by the host), so the pattern is locked to the canvas and does not
// shimmer when the surface resizes or the DPR changes.

struct Uniforms {
  /// Surface size in device pixels.
  resolution: vec2f,
  /// Paint mask dimensions in texels.
  mask_size: vec2f,
  /// Camera frame size in pixels; drives the aspect-fill crop.
  source_size: vec2f,
  /// Bayer cell side in device pixels (logical cell * dpr).
  cell: f32,
  /// 1.0 once a real frame has been uploaded to `frame_tex`.
  has_frame: f32,
  /// 1.0 to draw the wrist cursor.
  show_cursor: f32,
  /// Cursor ring radius in mask texels.
  cursor_radius: f32,
};

struct BrushState {
  prev: vec2f,
  current: vec2f,
  confidence: f32,
  tracking: f32,
  invalid: f32,
  has_prev: f32,
  stroke: f32,
  strokes: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var frame_tex: texture_2d<f32>;
@group(0) @binding(2) var frame_samp: sampler;
@group(0) @binding(3) var<storage, read> mask: array<f32>;
@group(0) @binding(4) var<storage, read> brush: BrushState;

/// 8x8 Bayer threshold index, 0..63.
///
/// `M(x,y) = sum_i 4^(k-1-i) * M2(bit_i(x), bit_i(y))`, LSB first, with
/// `M2(a,b) = ((a ^ b) << 1) | b`. Mirrored by `bayer8()` in pose-contract.ts,
/// which the unit tests pin against the literal standard matrix.
fn bayer8(p: vec2u) -> f32 {
  let x = p.x & 7u;
  let y = p.y & 7u;
  var value = 0u;
  for (var i = 0u; i < 3u; i = i + 1u) {
    let xb = (x >> i) & 1u;
    let yb = (y >> i) & 1u;
    value = (value << 2u) | (((xb ^ yb) << 1u) | yb);
  }
  return f32(value);
}

/// Surface uv -> `brush` space (mirrored, normalized camera frame), aspect-fill.
fn brush_uv(uv: vec2f) -> vec2f {
  let surface_aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
  let source_aspect = uniforms.source_size.x / max(uniforms.source_size.y, 1.0);
  var frame_uv = uv;
  if (source_aspect > surface_aspect) {
    // Frame is wider than the canvas: crop the sides.
    frame_uv.x = (uv.x - 0.5) * (surface_aspect / source_aspect) + 0.5;
  } else {
    frame_uv.y = (uv.y - 0.5) * (source_aspect / surface_aspect) + 0.5;
  }
  return frame_uv;
}

fn mask_at(p: vec2f) -> f32 {
  if (any(p < vec2f(0.0)) || any(p > vec2f(1.0))) {
    return 0.0;
  }
  let texel = vec2u(clamp(p * uniforms.mask_size, vec2f(0.0), uniforms.mask_size - vec2f(1.0)));
  return mask[texel.y * u32(uniforms.mask_size.x) + texel.x];
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let p = brush_uv(uv);

  // `p` is already mirrored, so un-mirror to read the raw (un-mirrored) frame.
  var raw = vec3f(0.05, 0.06, 0.09);
  if (uniforms.has_frame > 0.5) {
    raw = textureSample(frame_tex, frame_samp, vec2f(1.0 - p.x, p.y)).rgb;
  }

  // Fixed ordered dither, anchored in device pixels at a fixed cell size.
  let anchor = vec2u(floor(position.xy / max(uniforms.cell, 1.0)));
  let threshold = (bayer8(anchor) + 0.5) / 64.0;
  let luma = dot(raw, vec3f(0.2126, 0.7152, 0.0722));
  // Two-level warm/cool duotone: keeps a body and a face readable at 3 px cells.
  let cool = vec3f(0.055, 0.075, 0.13);
  let warm = vec3f(0.98, 0.86, 0.63);
  let dithered = mix(cool, warm, select(0.0, 1.0, luma > threshold));

  let coverage = mask_at(p);
  // mask 1 -> raw reality, mask 0 -> dither. Narrow feather at the stroke edge.
  var color = mix(dithered, raw, smoothstep(0.08, 0.6, coverage));
  let edge = smoothstep(0.08, 0.34, coverage) * (1.0 - smoothstep(0.34, 0.75, coverage));
  color = color + vec3f(0.32, 0.52, 0.9) * edge * 0.4;

  // Optional cursor, only while a wrist is tracked. Distance is measured in mask
  // texels so the ring stays round regardless of canvas shape.
  if (uniforms.show_cursor > 0.5 && brush.tracking > 0.5) {
    let d = distance(p * uniforms.mask_size, brush.current * uniforms.mask_size);
    let ring = smoothstep(uniforms.cursor_radius + 2.0, uniforms.cursor_radius, d)
      * smoothstep(uniforms.cursor_radius - 4.0, uniforms.cursor_radius - 1.5, d);
    color = mix(color, vec3f(0.95, 0.98, 1.0), ring * clamp(brush.confidence, 0.0, 1.0));
  }

  return vec4f(color, 1.0);
}
