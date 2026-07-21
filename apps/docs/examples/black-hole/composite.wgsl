struct Composite {
  exposure: f32,
  bloomStrength: f32,
}

@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> composite: Composite;

fn aces(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + vec3f(b))) / (x * (c * x + vec3f(d)) + vec3f(e)), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let hdrScene = textureSampleLevel(scene, samp, uv, 0.0).rgb;
  // The scene is sampled directly, but the bloom chain (bright-pass + 4 blur
  // passes) leaves the bloom target Y-inverted relative to the scene: WebGPU's
  // texture sample origin differs from the clip-space Y the passes render with,
  // and that discrepancy surfaces across the multi-pass chain. Flip uv.y when
  // sampling bloom so the glow aligns with the base image. Verified empirically
  // by isolating scene-only vs bloom-only renders (bloom matched only with the
  // flip). Do NOT remove this without re-running that comparison.
  let hdrBloom = textureSampleLevel(bloom, samp, vec2f(uv.x, 1.0 - uv.y), 0.0).rgb;
  var color = hdrScene + hdrBloom * composite.bloomStrength;

  color *= composite.exposure;
  color = aces(color);

  // Subtle cinematic vignette.
  let centered = uv - vec2f(0.5);
  let vignette = 1.0 - smoothstep(0.55, 1.15, length(centered) * 1.6);
  color *= mix(0.72, 1.0, vignette);

  color = pow(color, vec3f(1.0 / 2.2));
  return vec4f(color, 1.0);
}
