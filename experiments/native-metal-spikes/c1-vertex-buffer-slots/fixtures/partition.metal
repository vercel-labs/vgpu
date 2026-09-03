#include <metal_stdlib>
using namespace metal;

struct SwitchVertexIn {
  float4 value [[attribute(0)]];
};

struct SwitchVertexOut {
  float4 position [[position]];
  float4 color;
};

float2 switchFullscreenPosition(uint vertexID) {
  if (vertexID == 0) return float2(-1.0, -1.0);
  if (vertexID == 1) return float2(3.0, -1.0);
  return float2(-1.0, 3.0);
}

vertex SwitchVertexOut switchA(
  SwitchVertexIn input [[stage_in]],
  uint vertexID [[vertex_id]],
  constant float4& sharedValue [[buffer(0)]]) {
  SwitchVertexOut output;
  output.position = float4(switchFullscreenPosition(vertexID), 0.0, 1.0);
  output.color = input.value * sharedValue;
  return output;
}

vertex SwitchVertexOut switchB(
  SwitchVertexIn input [[stage_in]],
  uint vertexID [[vertex_id]],
  constant float4& sharedValue [[buffer(0)]],
  constant float4& programValue [[buffer(1)]]) {
  SwitchVertexOut output;
  output.position = float4(switchFullscreenPosition(vertexID), 0.0, 1.0);
  output.color = input.value * sharedValue * programValue;
  return output;
}

fragment float4 switchFragment(SwitchVertexOut input [[stage_in]]) {
  return input.color;
}
