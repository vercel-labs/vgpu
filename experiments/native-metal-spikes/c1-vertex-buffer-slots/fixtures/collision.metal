#include <metal_stdlib>
using namespace metal;

struct CollisionVertexIn {
  float value [[attribute(0)]];
};

struct CollisionVertexOut {
  float4 position [[position]];
  float value;
};

float2 collisionFullscreenPosition(uint vertexID) {
  if (vertexID == 0) return float2(-1.0, -1.0);
  if (vertexID == 1) return float2(3.0, -1.0);
  return float2(-1.0, 3.0);
}

vertex CollisionVertexOut collisionVertex(
  CollisionVertexIn input [[stage_in]],
  uint vertexID [[vertex_id]],
  constant float& shaderValue [[buffer(0)]]) {
  CollisionVertexOut output;
  output.position = float4(collisionFullscreenPosition(vertexID), 0.0, 1.0);
  output.value = input.value + shaderValue;
  return output;
}

fragment float4 collisionFragment(CollisionVertexOut input [[stage_in]]) {
  return float4(input.value, input.value, input.value, 1.0);
}
