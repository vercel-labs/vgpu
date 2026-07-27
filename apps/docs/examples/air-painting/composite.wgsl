// Fixed compositor: dithered everywhere, raw camera where the wrist has painted.
//
// The default is deliberate. Starting from a stylized 8x8 Bayer treatment makes
// the idle state look finished, and the first stroke then *reveals reality*,
// which reads far better than painting dither onto a normal feed. There is no
// effect selector.
//
// The bindings, the coordinate spaces and the `mask 1 = raw, mask 0 = dither`
// polarity are the frozen contract. The palette, the edge treatment and the
// cursor belong to the VISUAL owner and are tuned here.
//
// Palette: strictly two docs tokens, gray-12 ink on gray-1 paper, so the idle
// state reads as a monochrome newsprint halftone of the docs' own UI grays. The
// single blue accent (blue-9 / blue-10) is spent only on the stroke edge and the
// live cursor, so colour always means "you did this", never decoration. No
// gradients, no glow, no duotone.
//
// The stylization is deliberately one-sided: the dither branch lifts its shadows
// (`DITHER_GAMMA`) so the dark end of the frame still carries dot texture, while
// the revealed branch stays a raw, untouched passthrough of the camera. That is
// what makes the reveal read as *reality* rather than as a second filter.
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
  /// `@size(28)` pads the 40-byte struct to a 64-byte array stride.
  @size(28) strokes: f32,
};

/// One brush per hand; slot 0 is the person's left arm, slot 1 the right.
/// The array length is spelled as a literal on the binding below because
/// vgpu's auto-layout reflection requires one (VGPU-WGSL-REFLECT-ARRAY-LENGTH).
const BRUSH_COUNT: u32 = 2u;

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var frame_tex: texture_2d<f32>;
@group(0) @binding(2) var frame_samp: sampler;
@group(0) @binding(3) var<storage, read> mask: array<f32>;
@group(0) @binding(4) var<storage, read> brushes: array<BrushState, 2>;

/// gray-12 (#eeeeee): the docs' primary text colour, used as halftone ink.
const INK = vec3f(0.933, 0.933, 0.933);
/// gray-1 (#0a0a0a): the docs' default component background, used as paper.
const PAPER = vec3f(0.039, 0.039, 0.039);
/// blue-9 (#0070f3): the one accent, spent on the stroke edge.
const ACCENT = vec3f(0.0, 0.439, 0.953);
/// blue-10 (#3b9eff): the live cursor, one step brighter so it leads the eye.
const ACCENT_LIVE = vec3f(0.231, 0.62, 1.0);
/// Neutral stand-in before the first frame arrives; still dark enough to dither.
const NO_SIGNAL = vec3f(0.05, 0.05, 0.05);

/// Half-width of the accent hairline traced just outside the stroke, in texels.
const EDGE_TEXELS = 2.0;

/// Coverage window that turns mask coverage into ink. Tight on purpose: the mask
/// already carries a ~1-texel feather, so a narrow window reads as a confident
/// pen edge instead of a fuzzy blob, and the bilinear fetch below keeps it smooth.
const COVERAGE_LO = 0.42;
const COVERAGE_HI = 0.58;

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
/// would stair-step every stroke edge. Filtering here is what lets the coverage
/// window above stay tight: crisp ink, no jaggies.
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

/// Coverage dilated by `EDGE_TEXELS`; the difference against the undilated value
/// is the accent hairline. Deriving the outline from the mask itself keeps it a
/// constant width in texels instead of a resolution-dependent glow.
fn mask_dilated(p: vec2f) -> f32 {
  let step = EDGE_TEXELS / uniforms.mask_size;
  var m = mask_at(p + vec2f(step.x, 0.0));
  m = max(m, mask_at(p - vec2f(step.x, 0.0)));
  m = max(m, mask_at(p + vec2f(0.0, step.y)));
  m = max(m, mask_at(p - vec2f(0.0, step.y)));
  return m;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let p = brush_uv(uv);

  // `p` is already mirrored, so un-mirror to read the raw (un-mirrored) frame.
  var raw = NO_SIGNAL;
  if (uniforms.has_frame > 0.5) {
    raw = textureSample(frame_tex, frame_samp, vec2f(1.0 - p.x, p.y)).rgb;
  }

  // Fixed ordered dither, anchored in device pixels at a fixed cell size.
  let anchor = vec2u(floor(position.xy / max(uniforms.cell, 1.0)));
  let threshold = (bayer8(anchor) + 0.5) / 64.0;
  let luma = dot(raw, vec3f(0.2126, 0.7152, 0.0722));
  // Pure two-level ink on paper: one bit per cell, no intermediate tone at all,
  // and no grading of any kind. Everything you read as shading is dot *density*,
  // which is the whole point of an ordered dither and the reason the cell size
  // matters more than the palette does.
  let dithered = select(PAPER, INK, luma > threshold);

  let coverage = mask_at(p);
  // mask 1 -> raw reality, mask 0 -> dither. The window is narrow, so the
  // boundary is a pen edge rather than a fade.
  let inside = smoothstep(COVERAGE_LO, COVERAGE_HI, coverage);
  var color = mix(dithered, raw, inside);

  // A constant-width accent hairline just outside the stroke. Without it the
  // gesture disappears wherever the revealed frame happens to match the local dot
  // density; with it the painted line always reads as a deliberate mark.
  let outline = clamp(smoothstep(COVERAGE_LO, COVERAGE_HI, mask_dilated(p)) - inside, 0.0, 1.0);
  color = mix(color, ACCENT, outline * 0.75);

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
      // A thin open ring: it marks the brush tip without hiding what is under it.
      let ring = smoothstep(r + 2.2, r + 1.0, d) * smoothstep(r - 2.2, r - 1.0, d);
      color = mix(color, ACCENT_LIVE, ring * clamp(brush.confidence, 0.0, 1.0));
    }
  }

  return vec4f(color, 1.0);
}
