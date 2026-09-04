#include <metal_stdlib>

using namespace metal;

kernel void vgpu_c3_noop(device uint *values [[buffer(0)]],
                    uint id [[thread_position_in_grid]]) {
  values[id] = id;
}
