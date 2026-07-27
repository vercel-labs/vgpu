struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};
@group(0) @binding(0) var sceneHDR: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;

@vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  out.uv = vec2f(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return out;
}

fn LinearTosRGB(value: vec4f) -> vec4f {
  let lt = value.rgb * 12.92;
  let gt = 1.055 * pow(value.rgb, vec3f(0.41666)) - vec3f(0.055);
  let rgb = select(gt, lt, value.rgb <= vec3f(0.0031308));
  return vec4f(rgb, value.a);
}

@fragment fn fs_main(in: VSOut) -> @location(0) vec4f {
  let scene = textureSample(sceneHDR, linearSampler, in.uv);
  let bloom = textureSample(bloomTexture, linearSampler, in.uv);
  return LinearTosRGB(vec4f(scene.rgb + bloom.rgb, max(scene.a, bloom.a)));
}
