// Stamps both hands' antialiased capsules into the persistent paint mask.
//
// The mask is a fixed 960x540 logical grid of f32 coverage in `brush` space, so
// strokes survive canvas resize and DPR changes and the memory cost is a known
// 2,073,600 bytes. Accumulation is `max`, which is idempotent and needs no
// atomics: exactly one invocation owns each texel per dispatch, and it folds
// every brush into one value before it writes. Two hands painting the same
// texel in the same dispatch is therefore a plain `max`, not a race.
//
// Dispatch covers the whole mask because the capsule bounds live in GPU memory —
// deriving a tight dispatch range would mean reading the brush position back to
// the CPU, which is precisely what this example refuses to do. 518,400
// invocations of mostly-rejecting arithmetic is the cheaper trade.
//
// VISUAL owner: capsule quality, feather shape and any stroke texture are yours.
// The `stroke` gate, `max` accumulation and mask layout are the contract. Both
// hands share one radius and one feather on purpose: two different-weight lines
// would read as two different tools rather than as one pair of hands.

struct Uniforms {
  /// Mask dimensions in texels; also the brush-space -> texel scale.
  mask_size: vec2f,
  /// Capsule radius in mask texels.
  radius: f32,
  /// Coverage ramp width in mask texels.
  feather: f32,
  /// Per-step re-fog multiplier, `exp(-dt / tau)`, computed by `fogDecay()`.
  decay: f32,
  /// Coverage below which a texel snaps to exactly 0, so the glass really clears.
  clear_epsilon: f32,
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
@group(0) @binding(1) var<storage, read> brushes: array<BrushState, 2>;
@group(0) @binding(2) var<storage, read_write> mask: array<f32>;

/// Antialiased capsule coverage at `texel`, in mask texels.
fn capsule_coverage(texel: vec2f, brush: BrushState) -> f32 {
  let a = brush.prev * uniforms.mask_size;
  let b = brush.current * uniforms.mask_size;
  let ab = b - a;
  // A degenerate segment collapses to a round dot rather than dividing by zero.
  let t = clamp(dot(texel - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  let d = distance(texel, a + ab * t);
  return clamp((uniforms.radius - d) / max(uniforms.feather, 1e-3) + 0.5, 0.0, 1.0);
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let width = u32(uniforms.mask_size.x);
  let total = width * u32(uniforms.mask_size.y);
  let index = gid.x;
  if (index >= total) {
    return;
  }

  let texel = vec2f(f32(index % width), f32(index / width)) + vec2f(0.5);
  var coverage = 0.0;
  for (var i = 0u; i < BRUSH_COUNT; i = i + 1u) {
    let brush = brushes[i];
    // hand.wgsl decides whether each hand paints at all: an unconfident,
    // rejected, or freshly reacquired hand stamps nothing.
    if (brush.stroke < 0.5) {
      continue;
    }
    coverage = max(coverage, capsule_coverage(texel, brush));
  }

  let previous = mask[index];
  // Glass that is already fully fogged and is not being wiped has nothing to do.
  // That is the overwhelmingly common case across 518,400 invocations, and it is
  // the early-out that `clear_epsilon` exists to keep reachable: without the
  // snap-to-zero below, exponential decay would leave every texel ever wiped at
  // some vanishing non-zero value forever and this branch would never be taken
  // again.
  if (previous <= 0.0 && coverage <= 0.0) {
    return;
  }

  // Re-fog, then let the wipe win. `max` against the decayed value is what lets
  // a hand paint *through* the decay: a texel under the brush is pinned to the
  // brush's coverage no matter how long it has been fogging back up.
  let faded = previous * uniforms.decay;
  var next = max(faded, coverage);
  if (next < uniforms.clear_epsilon) {
    next = 0.0;
  }
  mask[index] = min(next, 1.0);
}
