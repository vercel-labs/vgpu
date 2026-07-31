// Bakes the IFFT displacement storage buffer into an rgba16float texture, one
// texel per element. Storage buffers are not available in the vertex stage on
// conservative adapters, so the ocean mesh samples this texture instead.

const NU: u32 = 256u;

@group(0) @binding(0) var<storage, read> disp: array<vec4f>;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let x = min(u32(uv.x * f32(NU)), NU - 1u);
  let z = min(u32(uv.y * f32(NU)), NU - 1u);
  return disp[z * NU + x];
}
