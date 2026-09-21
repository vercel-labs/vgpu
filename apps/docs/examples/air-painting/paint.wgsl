// Stamps both brushes into a persistent 960x540 coverage mask. One invocation
// owns each texel, so max accumulation needs no atomics or CPU brush readback.

struct Uniforms {
  mask_size: vec2f,
  radius: f32,
  feather: f32,
  decay: f32,
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
};

// Binding array lengths must be literals for vgpu reflection.
const BRUSH_COUNT: u32 = 2u;

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> brushes: array<BrushState, 2>;
@group(0) @binding(2) var<storage, read_write> mask: array<f32>;

fn capsule_coverage(texel: vec2f, brush: BrushState) -> f32 {
  let a = brush.prev * uniforms.mask_size;
  let b = brush.current * uniforms.mask_size;
  let ab = b - a;
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
    if (brush.stroke < 0.5) {
      continue;
    }
    coverage = max(coverage, capsule_coverage(texel, brush));
  }

  let previous = mask[index];
  // Snap tiny values to zero below so fully fogged texels can stay idle.
  if (previous <= 0.0 && coverage <= 0.0) {
    return;
  }

  let faded = previous * uniforms.decay;
  var next = max(faded, coverage);
  if (next < uniforms.clear_epsilon) {
    next = 0.0;
  }
  mask[index] = min(next, 1.0);
}
