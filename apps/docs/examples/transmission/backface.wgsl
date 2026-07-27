export struct BackfaceSample {
  normal: vec3f,
  thickness: f32,
  amount: f32,
};

/** Decodes the screen-space far-face G-buffer and applies the roughness handoff. */
export fn decode_backface(back: vec4f, front_distance: f32, fallback_normal: vec3f, fallback_thickness: f32, roughness: f32, enabled: bool) -> BackfaceSample {
  let has_back = step(1e-4, dot(back.xyz, back.xyz));
  let amount = has_back * select(0.0, 1.0 - smoothstep(0.18, 0.8, roughness), enabled);
  let thickness = mix(fallback_thickness, clamp(back.w - front_distance, 0.02, 4.0), amount);
  let normal = normalize(mix(-fallback_normal, back.xyz, amount));
  return BackfaceSample(normal, thickness, amount);
}
