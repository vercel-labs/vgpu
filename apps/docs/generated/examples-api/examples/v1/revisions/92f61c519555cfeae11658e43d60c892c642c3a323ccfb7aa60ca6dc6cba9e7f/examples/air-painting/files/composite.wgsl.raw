// Fogged glass you wipe clean with your hands.
//
// The default state is the camera feed behind frosted glass. Your hands wipe it
// clear, and it slowly fogs back up. That is the whole metaphor, and it is why
// the idle state is the *stylized* one: the first wipe reveals reality, which
// reads far better than smearing an effect onto an already-normal feed. There is
// no effect selector.
//
// The frozen contract is the bindings, the coordinate spaces, and the polarity:
// `mask 1 = clean glass, mask 0 = fully frosted`. Everything else here -- the
// lift, the grain, the rim, the cursor -- is tuning.
//
// The single most important line in this file is the `mix()` at the bottom: the
// mask *lerps the blur amount* rather than selecting between two images. Because
// the mask decays continuously (see paint.wgsl), a wiped patch does not blink
// back to frosted, it silts up gradually, which is what makes the re-fog read as
// condensation rather than as a light being switched off.
//
// Palette: monochrome, flat, no gradients. Frost lifts toward white because that
// is what scattered light does in condensation, never toward a colour. The one
// accent (blue-10) is spent solely on the live cursor, so colour always means
// "your hand is here", never decoration.

struct Uniforms {
  /// Surface size in device pixels.
  resolution: vec2f,
  /// Paint mask dimensions in texels.
  mask_size: vec2f,
  /// Camera frame size in pixels; drives the aspect-fill crop.
  source_size: vec2f,
  /// 1.0 once a real frame has been uploaded to `frame_tex`.
  has_frame: f32,
  /// 1.0 to draw the hand cursors.
  show_cursor: f32,
  /// Cursor ring radius in mask texels.
  cursor_radius: f32,
  /// How far the frost lifts toward white.
  frost_lift: f32,
  /// Amplitude of the static frost grain.
  frost_grain: f32,
  /// Grain cell side in device pixels (logical cell * dpr).
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
  /// `@size(28)` pads the 40-byte struct to a 64-byte array stride.
  @size(28) strokes: f32,
};

/// One brush per hand, indexed by persistent track slot.
/// The array length is spelled as a literal on the binding below because
/// vgpu's auto-layout reflection requires one (VGPU-WGSL-REFLECT-ARRAY-LENGTH).
const BRUSH_COUNT: u32 = 2u;

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var frame_tex: texture_2d<f32>;
@group(0) @binding(2) var frame_samp: sampler;
@group(0) @binding(3) var<storage, read> mask: array<f32>;
@group(0) @binding(4) var<storage, read> brushes: array<BrushState, 2>;
/// The twice-blurred, quarter-resolution feed from frost.wgsl.
@group(0) @binding(5) var frost_tex: texture_2d<f32>;

/// blue-10 (#3b9eff): the one accent, spent only on the live cursor.
const ACCENT_LIVE = vec3f(0.231, 0.62, 1.0);
/// gray-1 (#0a0a0a): the docs' component background, shown before the first frame.
const NO_SIGNAL = vec3f(0.039, 0.039, 0.039);

/// Half-width of the condensation rim traced just outside a wipe, in texels.
const RIM_TEXELS = 3.0;
/// How much brighter the rim is. Wiping real glass piles moisture at the edge;
/// this is that, kept far enough down that it reads as physics, not as a stroke.
const RIM_GAIN = 0.14;

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

/// One mask texel, zero outside the grid. Keeps the border from smearing.
fn mask_texel(t: vec2i) -> f32 {
  let size = vec2i(uniforms.mask_size);
  if (t.x < 0 || t.y < 0 || t.x >= size.x || t.y >= size.y) {
    return 0.0;
  }
  return mask[u32(t.y) * u32(uniforms.mask_size.x) + u32(t.x)];
}

/// Bilinear coverage in `brush` space.
///
/// The mask is 960x540 while the canvas is usually larger, so a nearest fetch
/// would stair-step every wipe edge into visible blocks.
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

/// Coverage dilated by `RIM_TEXELS`; the difference against the undilated value
/// is the condensation rim. Deriving it from the mask keeps it a constant width
/// in texels rather than a resolution-dependent glow.
fn mask_dilated(p: vec2f) -> f32 {
  let step = RIM_TEXELS / uniforms.mask_size;
  var m = mask_at(p + vec2f(step.x, 0.0));
  m = max(m, mask_at(p - vec2f(step.x, 0.0)));
  m = max(m, mask_at(p + vec2f(0.0, step.y)));
  m = max(m, mask_at(p - vec2f(0.0, step.y)));
  return m;
}

/// Static value noise in fixed-size cells. Deliberately not animated: this is
/// frost sitting on glass, and moving grain would read as sensor noise.
///
/// Quantizing to a cell is what makes it look like droplets rather than
/// television static, and it is also what keeps the committed thumbnail
/// compressible -- per-pixel noise is, by definition, incompressible.
fn grain(p: vec2f) -> f32 {
  let cell = floor(p / max(uniforms.grain_cell, 1.0));
  return fract(sin(dot(cell, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let p = brush_uv(uv);

  // `p` is already mirrored, so un-mirror to read the raw (un-mirrored) frame.
  let source_uv = vec2f(1.0 - p.x, p.y);
  var sharp = NO_SIGNAL;
  var blurred = NO_SIGNAL;
  if (uniforms.has_frame > 0.5) {
    sharp = textureSample(frame_tex, frame_samp, source_uv).rgb;
    blurred = textureSample(frost_tex, frame_samp, source_uv).rgb;
  }

  // Frost: the blurred feed, lifted toward white and dusted with fixed grain.
  // The lift is what separates "out of focus" from "behind glass".
  var frost = mix(blurred, vec3f(1.0), uniforms.frost_lift);
  frost = frost + vec3f(grain(position.xy) * uniforms.frost_grain);
  frost = clamp(frost, vec3f(0.0), vec3f(1.0));

  // The wipe. Coverage lerps the blur amount directly -- no threshold, no
  // smoothstep window -- so a decaying mask fogs back up continuously.
  let wipe = clamp(mask_at(p), 0.0, 1.0);
  var color = mix(frost, sharp, wipe);

  // Condensation piled at the edge of the wipe.
  let rim = clamp(mask_dilated(p) - wipe, 0.0, 1.0);
  color = color + vec3f(rim * RIM_GAIN);

  // One cursor per tracked hand. Distance is measured in mask texels so the ring
  // stays round regardless of canvas shape.
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
