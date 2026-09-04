#include <metal_stdlib>

using namespace metal;

[[max_total_threads_per_threadgroup(4)]]
kernel void vgpu_c3_noop(device uint *values [[buffer(0)]],
                    uint id [[thread_position_in_grid]]) {
  values[id] = id;
}
