export const goldenAngle: f32 = 2.3999631;

const inverseU32Range: f32 = 2.3283064e-10;

export fn vogelDisk(index: u32, count: u32, phi: f32) -> vec2f {
  if (count == 0u) {
    return vec2f(0.0);
  }

  let angle = f32(index) * goldenAngle + phi;
  let radius = sqrt((f32(index) + 0.5) / f32(count));
  return vec2f(cos(angle), sin(angle)) * radius;
}

export fn radicalInverseVdc(bits: u32) -> f32 {
  var value = bits;
  value = (value << 16u) | (value >> 16u);
  value = ((value & 0x55555555u) << 1u) | ((value & 0xaaaaaaaau) >> 1u);
  value = ((value & 0x33333333u) << 2u) | ((value & 0xccccccccu) >> 2u);
  value = ((value & 0x0f0f0f0fu) << 4u) | ((value & 0xf0f0f0f0u) >> 4u);
  value = ((value & 0x00ff00ffu) << 8u) | ((value & 0xff00ff00u) >> 8u);
  return min(f32(value) * inverseU32Range, 0.99999994);
}

export fn hammersley2d(index: u32, count: u32) -> vec2f {
  if (count == 0u) {
    return vec2f(0.0);
  }

  return vec2f(f32(index) / f32(count), radicalInverseVdc(index));
}
