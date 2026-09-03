#include <metal_stdlib>

using namespace metal;

kernel void c3_noop(
  device uint *output [[buffer(0)]],
  uint index [[thread_position_in_grid]]
) {
  output[index] = index;
}
