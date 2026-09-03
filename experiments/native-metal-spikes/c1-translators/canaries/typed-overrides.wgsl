override GAIN: f32 = 1.0;
override WG_X: u32 = 8u;
override ENABLED: bool = false;

struct Data {
  values: array<f32>,
}

@group(0) @binding(0) var<storage, read_write> data: Data;

@compute @workgroup_size(WG_X, 1, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  if ENABLED {
    data.values[id.x] *= GAIN;
  }
}
