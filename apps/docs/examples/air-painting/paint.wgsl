// Stamps one antialiased capsule into the persistent paint mask.
//
// The mask is a fixed 960x540 logical grid of f32 coverage in `brush` space, so
// strokes survive canvas resize and DPR changes and the memory cost is a known
// 2,073,600 bytes. Accumulation is `max`, which is idempotent and needs no
// atomics: exactly one invocation owns each texel per dispatch.
//
// Dispatch covers the whole mask because the capsule bounds live in GPU memory —
// deriving a tight dispatch range would mean reading the brush position back to
// the CPU, which is precisely what this example refuses to do. 518,400
// invocations of mostly-rejecting arithmetic is the cheaper trade.
//
// VISUAL owner: capsule quality, feather shape and any stroke texture are yours.
// The `stroke` gate, `max` accumulation and mask layout are the contract.

struct Uniforms {
  /// Mask dimensions in texels; also the brush-space -> texel scale.
  mask_size: vec2f,
  /// Capsule radius in mask texels.
  radius: f32,
  /// Coverage ramp width in mask texels.
  feather: f32,
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
@group(0) @binding(1) var<storage, read> brush: BrushState;
@group(0) @binding(2) var<storage, read_write> mask: array<f32>;

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let width = u32(uniforms.mask_size.x);
  let total = width * u32(uniforms.mask_size.y);
  let index = gid.x;
  if (index >= total) {
    return;
  }
  // wrist.wgsl decides whether this result paints at all: an unconfident,
  // rejected, or freshly reacquired wrist stamps nothing.
  if (brush.stroke < 0.5) {
    return;
  }

  let texel = vec2f(f32(index % width), f32(index / width)) + vec2f(0.5);
  let a = brush.prev * uniforms.mask_size;
  let b = brush.current * uniforms.mask_size;
  let ab = b - a;
  // A degenerate segment collapses to a round dot rather than dividing by zero.
  let t = clamp(dot(texel - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  let d = distance(texel, a + ab * t);
  let coverage = clamp((uniforms.radius - d) / max(uniforms.feather, 1e-3) + 0.5, 0.0, 1.0);

  mask[index] = max(mask[index], coverage);
}
