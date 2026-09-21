// Mask coverage continuously mixes frosted and sharp camera feeds:
// 0 is fully frosted, 1 is wiped clean. Blue is reserved for live cursors.

struct Uniforms {
  resolution: vec2f,
  mask_size: vec2f,
  source_size: vec2f,
  has_frame: f32,
  show_cursor: f32,
  cursor_radius: f32,
  frost_lift: f32,
  frost_grain: f32,
  grain_cell: f32,
};

struct BrushState {
  prev: vec2f,
  current: vec2f,
  confidence: f32,
  tracking: f32,
  invalid: f32,
  has_prev: f32,
  stroke: f32,
};

// Binding array lengths must be literals for vgpu reflection.
const BRUSH_COUNT: u32 = 2u;

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var frame_tex: texture_2d<f32>;
@group(0) @binding(2) var frame_samp: sampler;
@group(0) @binding(3) var<storage, read> mask: array<f32>;
@group(0) @binding(4) var<storage, read> brushes: array<BrushState, 2>;
@group(0) @binding(5) var frost_tex: texture_2d<f32>;

const ACCENT_LIVE = vec3f(0.231, 0.62, 1.0);
const NO_SIGNAL = vec3f(0.039, 0.039, 0.039);
const RIM_TEXELS = 3.0;
const RIM_GAIN = 0.14;

// Surface UV to mirrored, aspect-fill camera space.
fn brush_uv(uv: vec2f) -> vec2f {
  let surface_aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
  let source_aspect = uniforms.source_size.x / max(uniforms.source_size.y, 1.0);
  var frame_uv = uv;
  if (source_aspect > surface_aspect) {
    frame_uv.x = (uv.x - 0.5) * (surface_aspect / source_aspect) + 0.5;
  } else {
    frame_uv.y = (uv.y - 0.5) * (source_aspect / surface_aspect) + 0.5;
  }
  return frame_uv;
}

fn mask_texel(t: vec2i) -> f32 {
  let size = vec2i(uniforms.mask_size);
  if (t.x < 0 || t.y < 0 || t.x >= size.x || t.y >= size.y) {
    return 0.0;
  }
  return mask[u32(t.y) * u32(uniforms.mask_size.x) + u32(t.x)];
}

// Bilinear mask coverage avoids stair-stepped wipe edges.
fn mask_at(p: vec2f) -> f32 {
  if (any(p < vec2f(0.0)) || any(p > vec2f(1.0))) {
    return 0.0;
  }
  let texel = p * uniforms.mask_size - vec2f(0.5);
  let base = floor(texel);
  let f = texel - base;
  let b = vec2i(base);
  let c00 = mask_texel(b);
  let c10 = mask_texel(b + vec2i(1, 0));
  let c01 = mask_texel(b + vec2i(0, 1));
  let c11 = mask_texel(b + vec2i(1, 1));
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

// Dilated coverage minus coverage forms the condensation rim.
fn mask_dilated(p: vec2f) -> f32 {
  let step = RIM_TEXELS / uniforms.mask_size;
  var m = mask_at(p + vec2f(step.x, 0.0));
  m = max(m, mask_at(p - vec2f(step.x, 0.0)));
  m = max(m, mask_at(p + vec2f(0.0, step.y)));
  m = max(m, mask_at(p - vec2f(0.0, step.y)));
  return m;
}

// Static cell noise reads as frost and keeps thumbnails compressible.
fn grain(p: vec2f) -> f32 {
  let cell = floor(p / max(uniforms.grain_cell, 1.0));
  return fract(sin(dot(cell, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let p = brush_uv(uv);

  // Un-mirror brush space to sample the raw camera frame.
  let source_uv = vec2f(1.0 - p.x, p.y);
  var sharp = NO_SIGNAL;
  var blurred = NO_SIGNAL;
  if (uniforms.has_frame > 0.5) {
    sharp = textureSample(frame_tex, frame_samp, source_uv).rgb;
    blurred = textureSample(frost_tex, frame_samp, source_uv).rgb;
  }

  // Lift the blurred feed toward white and add fixed grain.
  var frost = mix(blurred, vec3f(1.0), uniforms.frost_lift);
  frost = frost + vec3f(grain(position.xy) * uniforms.frost_grain);
  frost = clamp(frost, vec3f(0.0), vec3f(1.0));

  // Direct interpolation lets a decaying wipe fog back continuously.
  let wipe = clamp(mask_at(p), 0.0, 1.0);
  var color = mix(frost, sharp, wipe);

  let rim = clamp(mask_dilated(p) - wipe, 0.0, 1.0);
  color = color + vec3f(rim * RIM_GAIN);

  // Mask-space distance keeps cursor rings round at every canvas aspect.
  if (uniforms.show_cursor > 0.5) {
    for (var i = 0u; i < BRUSH_COUNT; i = i + 1u) {
      let brush = brushes[i];
      if (brush.tracking < 0.5) {
        continue;
      }
      let d = distance(p * uniforms.mask_size, brush.current * uniforms.mask_size);
      let r = uniforms.cursor_radius;
      let ring = smoothstep(r + 2.2, r + 1.0, d) *
                 smoothstep(r - 2.2, r - 1.0, d);
      color = mix(color, ACCENT_LIVE, ring * clamp(brush.confidence, 0.0, 1.0));
    }
  }

  return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), 1.0);
}
