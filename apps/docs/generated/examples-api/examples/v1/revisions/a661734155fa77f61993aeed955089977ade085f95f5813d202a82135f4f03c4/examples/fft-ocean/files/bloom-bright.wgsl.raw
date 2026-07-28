struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
struct BrightUniforms {
  luminosityThreshold: f32,
  smoothWidth: f32,
  _pad0: vec2f,
};
@group(0) @binding(0) var<uniform> uniforms: BrightUniforms;
@group(0) @binding(1) var tDiffuse: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = vec2f(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return out;
}

fn luminance(rgb: vec3f) -> f32 {
  return dot(rgb, vec3f(0.299, 0.587, 0.114));
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  // LuminosityHighPassShader.js @ three 0.184.0, with defaultColor=0 and defaultOpacity=0.
  let texel = textureSample(tDiffuse, linearSampler, in.uv);
  let v = luminance(texel.xyz);
  let outputColor = vec4f(vec3f(0.0), 0.0);
  let alpha = smoothstep(uniforms.luminosityThreshold, uniforms.luminosityThreshold + uniforms.smoothWidth, v);
  return mix(outputColor, texel, alpha);
}
