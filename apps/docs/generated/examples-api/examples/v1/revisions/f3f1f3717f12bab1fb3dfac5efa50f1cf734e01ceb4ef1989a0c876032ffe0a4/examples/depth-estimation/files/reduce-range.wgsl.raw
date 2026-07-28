// Reduces the depth tensor to its minimum and maximum, on the GPU.
//
// MiDaS and Depth Anything emit *relative* inverse depth: the numbers only mean
// something next to the other numbers in the same frame, and the scale moves
// from scene to scene. Presenting them needs that frame's range — but reading
// the tensor back to the CPU to compute it would throw away the whole point of
// the example, which is that the model output never leaves the GPU.
//
// So the range is reduced here and handed to `relief.wgsl` as two u32 keys.
//
// One workgroup does the whole job. The largest output is 560x448 = 250,880
// scalars, so 64 threads walk ~3,900 elements each and then tree-reduce in
// shared memory. That is far too little work to bother spreading across the
// device, and it keeps this to a single dispatch with no atomics.
//
// 64 rather than a wider group on purpose: WebGPU only guarantees a workgroup
// size of 256 in its default limits, and real devices report less -- the Node
// software adapter used for thumbnails caps this dimension at 128.

struct Uniforms {
  /// Number of valid f32 scalars in `depth`.
  count: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> depth: array<f32>;
/// [0] = minimum key, [1] = maximum key. Order-preserving u32 encodings.
@group(0) @binding(2) var<storage, read_write> range: array<u32>;

const THREADS: u32 = 64u;

var<workgroup> shared_min: array<u32, 64>;
var<workgroup> shared_max: array<u32, 64>;

/// Maps a float to a u32 whose unsigned ordering matches float ordering, so the
/// reduction can use plain integer min/max. Negative floats invert, positive
/// floats get their sign bit set.
fn key_of(value: f32) -> u32 {
  let bits = bitcast<u32>(value);
  let mask = select(0x80000000u, 0xFFFFFFFFu, (bits & 0x80000000u) != 0u);
  return bits ^ mask;
}

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) lane: u32) {
  var local_min = 0xFFFFFFFFu;
  var local_max = 0u;

  var i = lane;
  loop {
    if (i >= uniforms.count) { break; }
    let value = depth[i];
    // Skip NaN: a single one would poison the range and blank the picture.
    if (value == value) {
      let key = key_of(value);
      local_min = min(local_min, key);
      local_max = max(local_max, key);
    }
    i = i + THREADS;
  }

  shared_min[lane] = local_min;
  shared_max[lane] = local_max;
  workgroupBarrier();

  var stride = THREADS / 2u;
  loop {
    if (stride == 0u) { break; }
    if (lane < stride) {
      shared_min[lane] = min(shared_min[lane], shared_min[lane + stride]);
      shared_max[lane] = max(shared_max[lane], shared_max[lane + stride]);
    }
    workgroupBarrier();
    stride = stride / 2u;
  }

  if (lane == 0u) {
    range[0] = shared_min[0];
    range[1] = shared_max[0];
  }
}
