override KERNEL_RADIUS: u32 = 6u;
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
struct BlurUniforms {
  direction: vec2f,
  invSize: vec2f,
  gaussianCoefficients0: vec4f,
  gaussianCoefficients1: vec4f,
  gaussianCoefficients2: vec4f,
  gaussianCoefficients3: vec4f,
  gaussianCoefficients4: vec4f,
  gaussianCoefficients5: vec4f,
};
@group(0) @binding(0) var<uniform> uniforms: BlurUniforms;
@group(0) @binding(1) var colorTexture: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = vec2f(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return out;
}

fn coefficient(i: u32) -> f32 {
  let v = array<f32, 24>(
    uniforms.gaussianCoefficients0.x, uniforms.gaussianCoefficients0.y, uniforms.gaussianCoefficients0.z, uniforms.gaussianCoefficients0.w,
    uniforms.gaussianCoefficients1.x, uniforms.gaussianCoefficients1.y, uniforms.gaussianCoefficients1.z, uniforms.gaussianCoefficients1.w,
    uniforms.gaussianCoefficients2.x, uniforms.gaussianCoefficients2.y, uniforms.gaussianCoefficients2.z, uniforms.gaussianCoefficients2.w,
    uniforms.gaussianCoefficients3.x, uniforms.gaussianCoefficients3.y, uniforms.gaussianCoefficients3.z, uniforms.gaussianCoefficients3.w,
    uniforms.gaussianCoefficients4.x, uniforms.gaussianCoefficients4.y, uniforms.gaussianCoefficients4.z, uniforms.gaussianCoefficients4.w,
    uniforms.gaussianCoefficients5.x, uniforms.gaussianCoefficients5.y, uniforms.gaussianCoefficients5.z, uniforms.gaussianCoefficients5.w
  );
  return v[i];
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  // UnrealBloomPass._getSeparableBlurMaterial @ three 0.184.0.
  var weightSum = coefficient(0u);
  var diffuseSum = textureSample(colorTexture, linearSampler, in.uv).rgb * weightSum;
  for (var i = 1u; i < KERNEL_RADIUS; i = i + 1u) {
    let x = f32(i);
    let w = coefficient(i);
    let uvOffset = uniforms.direction * uniforms.invSize * x;
    let sample1 = textureSample(colorTexture, linearSampler, in.uv + uvOffset).rgb;
    let sample2 = textureSample(colorTexture, linearSampler, in.uv - uvOffset).rgb;
    diffuseSum = diffuseSum + (sample1 + sample2) * w;
  }
  return vec4f(diffuseSum, 1.0);
}
