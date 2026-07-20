struct Uniforms {
  resolution: vec2f,
  time: f32,
  bloomStrength: f32,
  caAmount: f32,
  grainAmount: f32,
  bloomOn: f32,
  caOn: f32,
  grainOn: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var scene_tex: texture_2d<f32>;
@group(0) @binding(2) var bloom_tex: texture_2d<f32>;
@group(0) @binding(3) var linear_samp: sampler;

fn hash21(p: vec2f) -> f32 {
  let q = fract(vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3))));
  return fract(sin(q.x + q.y) * 43758.5453);
}

fn load_scene(uv: vec2f) -> vec3f {
  let dims = vec2i(textureDimensions(scene_tex));
  let pixel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  return textureLoad(scene_tex, pixel, 0).rgb;
}

fn load_bloom(uv: vec2f) -> vec3f {
  let dims = vec2i(textureDimensions(bloom_tex));
  let pixel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  return textureLoad(bloom_tex, pixel, 0).rgb;
}

fn sampleComposite(uv: vec2f) -> vec3f {
  let scene = load_scene(uv);
  let bloom = load_bloom(uv) * uniforms.bloomStrength * uniforms.bloomOn;
  return scene + bloom;
}

@fragment
fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / uniforms.resolution;
  let centered = uv - vec2f(0.5);
  let radial = length(centered);
  let dir = select(vec2f(0.0), normalize(centered), radial > 0.0001);
  let aberration = dir * uniforms.caAmount * uniforms.caOn * radial * radial;

  var color = sampleComposite(uv);
  let caColor = vec3f(
    sampleComposite(clamp(uv + aberration, vec2f(0.001), vec2f(0.999))).r,
    sampleComposite(uv).g,
    sampleComposite(clamp(uv - aberration, vec2f(0.001), vec2f(0.999))).b,
  );
  color = mix(color, caColor, uniforms.caOn);

  let grain = hash21(position.xy + vec2f(uniforms.time * 47.13, uniforms.time * 19.71)) - 0.5;
  color += grain * uniforms.grainAmount * uniforms.grainOn;

  let vignette = smoothstep(0.92, 0.30, distance(uv, vec2f(0.5)));
  color *= 0.72 + 0.32 * vignette;
  color = pow(max(color, vec3f(0.0)), vec3f(0.92));

  return vec4f(color, 1.0);
}
