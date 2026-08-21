struct Params { light: vec2f, sceneTexel: vec2f, aspect: vec2f, spotReach: f32, spotStroke: f32 }
@group(0) @binding(0) var linearSampler: sampler;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  var sharp = 0.0;
  let radius = max(0.5, params.spotStroke);
  for (var j = -3; j <= 3; j++) {
    for (var i = -3; i <= 3; i++) {
      let offset = vec2f(f32(i), f32(j)) * (radius / 3.0);
      if (length(offset) <= radius + 0.001) {
        sharp = max(sharp, textureSample(sceneTexture, linearSampler, uv + offset * params.sceneTexel).r);
      }
    }
  }
  let present = smoothstep(0.0015, 0.02, sharp);
  let distanceToLight = length((params.light - uv) * params.aspect);
  let falloff = mix(9.0, 0.4, params.spotReach);
  // pow(2) on the base steepens the SVG gradient falloff along the strokes.
  let lit = (sharp * sharp) * present / (1.0 + distanceToLight * distanceToLight * falloff);
  return vec4f(vec3f(lit), 1.0);
}
