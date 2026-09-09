import { HazeUpdate } from "./haze-temporal.wgsl";

@group(0) @binding(0) var march: texture_2d<f32>;
@group(0) @binding(1) var history: texture_2d<f32>;
@group(0) @binding(2) var<uniform> update: HazeUpdate;

@fragment fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixel = vec2i(fragCoord.xy);
  let size = vec2i(textureDimensions(march));
  let center = textureLoad(march, pixel, 0);
  var sum = vec3f(0.0);
  var weightSum = 0.0;
  var lo = center.rgb;
  var hi = center.rgb;
  // Only the volumetric shadow is filtered: terrain shading and the solar disc stay at full sharpness.
  // Reject sky/ground neighbours and strongly downweight distance breaks so ridges do not grow a haze halo.
  for (var y = -1; y <= 1; y += 1) {
    for (var x = -1; x <= 1; x += 1) {
      let tap = textureLoad(march, clamp(pixel + vec2i(x, y), vec2i(0), size - 1), 0);
      if ((tap.a >= 0.0) != (center.a >= 0.0)) { continue; }
      let depthScale = max(0.02, abs(center.a) * 0.02);
      let depthWeight = exp(-abs(tap.a - center.a) / depthScale);
      let weight = depthWeight * select(1.0, 2.0, x == 0) * select(1.0, 2.0, y == 0);
      sum += tap.rgb * weight;
      weightSum += weight;
      if (depthWeight > 0.1) { lo = min(lo, tap.rgb); hi = max(hi, tap.rgb); }
    }
  }
  let fresh = sum / weightSum;
  if (update.valid < 0.5) { return vec4f(fresh, center.a); }
  let old = textureLoad(history, pixel, 0);
  // Exact texel history is used only at rest. Clipping also sheds stale moving cloud shadows between state changes.
  if ((old.a >= 0.0) != (center.a >= 0.0) || abs(old.a - center.a) > max(0.02, abs(center.a) * 0.02)) {
    return vec4f(fresh, center.a);
  }
  return vec4f(mix(clamp(old.rgb, lo, hi), fresh, update.blend), center.a);
}
