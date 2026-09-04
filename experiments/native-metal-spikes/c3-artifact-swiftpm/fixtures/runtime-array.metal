#include <metal_stdlib>

using namespace metal;

kernel void vgpu_c3_runtime_array(device const uint *runtime_values [[buffer(0)]],
                             constant uint *immediate_data [[buffer(30)]]) {
  if (immediate_data[1] == 0u) {
    return;
  }
  (void)runtime_values[1];
}
