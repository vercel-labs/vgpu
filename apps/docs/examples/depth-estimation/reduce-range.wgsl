// One 64-thread workgroup reduces a relative-depth frame without a CPU readback.
struct Uniforms {
  count: u32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> depth: array<f32>;
@group(0) @binding(2) var<storage, read_write> range: array<u32>;

const THREADS: u32 = 64u;
var<workgroup> shared_min: array<u32, 64>;
var<workgroup> shared_max: array<u32, 64>;

// Order-preserving float key, allowing integer min/max.
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
