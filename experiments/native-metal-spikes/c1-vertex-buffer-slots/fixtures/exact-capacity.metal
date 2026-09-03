#include <metal_stdlib>
using namespace metal;

struct ExactVertexIn {
  float value0 [[attribute(0)]];
  float value1 [[attribute(1)]];
  float value2 [[attribute(2)]];
  float value3 [[attribute(3)]];
  float value4 [[attribute(4)]];
  float value5 [[attribute(5)]];
  float value6 [[attribute(6)]];
  float value7 [[attribute(7)]];
};

struct ExactVertexOut {
  float4 position [[position]];
  float4 color;
};

float2 exactFullscreenPosition(uint vertexID) {
  if (vertexID == 0) return float2(-1.0, -1.0);
  if (vertexID == 1) return float2(3.0, -1.0);
  return float2(-1.0, 3.0);
}

vertex ExactVertexOut exactCapacityVertex(
  ExactVertexIn input [[stage_in]],
  uint vertexID [[vertex_id]],
  constant float& buffer0 [[buffer(0)]],
  constant float& buffer1 [[buffer(1)]],
  constant float& buffer2 [[buffer(2)]],
  constant float& buffer3 [[buffer(3)]],
  constant float& buffer4 [[buffer(4)]],
  constant float& buffer5 [[buffer(5)]],
  constant float& buffer6 [[buffer(6)]],
  constant float& buffer7 [[buffer(7)]],
  constant float& buffer8 [[buffer(8)]],
  constant float& buffer9 [[buffer(9)]],
  constant float& buffer10 [[buffer(10)]],
  constant float& buffer11 [[buffer(11)]],
  device const float& buffer12 [[buffer(12)]],
  device const float& buffer13 [[buffer(13)]],
  device const float& buffer14 [[buffer(14)]],
  device const float& buffer15 [[buffer(15)]],
  device const float& buffer16 [[buffer(16)]],
  device const float& buffer17 [[buffer(17)]],
  device const float& buffer18 [[buffer(18)]],
  device const float& buffer19 [[buffer(19)]],
  device const float& buffer20 [[buffer(20)]],
  constant float& immediateData [[buffer(29)]],
  constant float& storageBufferSizes [[buffer(30)]]) {
  float attributeSum =
    input.value0 + input.value1 + input.value2 + input.value3 +
    input.value4 + input.value5 + input.value6 + input.value7;
  float constantSum =
    buffer0 + buffer1 + buffer2 + buffer3 + buffer4 + buffer5 +
    buffer6 + buffer7 + buffer8 + buffer9 + buffer10 + buffer11 +
    immediateData + storageBufferSizes;
  float deviceSum =
    buffer12 + buffer13 + buffer14 + buffer15 + buffer16 + buffer17 +
    buffer18 + buffer19 + buffer20;
  ExactVertexOut output;
  output.position = float4(exactFullscreenPosition(vertexID), 0.0, 1.0);
  output.color = float4(attributeSum, constantSum, deviceSum, 1.0);
  return output;
}

fragment float4 exactCapacityFragment(ExactVertexOut input [[stage_in]]) {
  return input.color;
}
