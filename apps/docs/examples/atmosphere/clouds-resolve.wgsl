import { CloudUpdate, compactCoordinate, compactSize, isLiveTexel, texelToCompact } from "./clouds-temporal.wgsl";

@group(0) @binding(0) var marchColor: texture_2d<f32>;
@group(0) @binding(1) var history: texture_2d<f32>;
@group(0) @binding(2) var lutSampler: sampler;
@group(0) @binding(3) var<uniform> update: CloudUpdate;

// Builds this frame's cloud history: live texels take this frame's march from the compact target, blended into
// their history while accumulating; the others keep last frame's value. The camera cannot have moved when a texel is
// kept (any camera change refreshes every texel), so the history is read at the exact texel and never resampled.

/** This frame's march interpolated from the nearest live texels, for texels that have neither a march nor a history. */
fn nearestMarch(texel: vec2f, frameIndex: i32, period: i32) -> vec4f {
  let compact = vec2f(compactSize(vec2i(update.size), period));
  let coordinate = clamp(compactCoordinate(texel, frameIndex, period), vec2f(0.0), compact - 1.0);
  return textureSampleLevel(marchColor, lutSampler, (coordinate + 0.5) / vec2f(textureDimensions(marchColor)), 0.0);
}

@fragment fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let texel = vec2i(fragCoord.xy);
  let period = i32(update.refreshPeriod);
  let frameIndex = i32(update.frame);
  let historyValid = update.valid > 0.5;
  if (!isLiveTexel(texel, frameIndex, period)) {
    if (historyValid) { return textureLoad(history, texel, 0); }
    return nearestMarch(vec2f(fragCoord.xy), frameIndex, period);
  }
  let fresh = textureLoad(marchColor, texelToCompact(texel, period), 0);
  if (historyValid && update.blend < 1.0) { return mix(textureLoad(history, texel, 0), fresh, update.blend); }
  return fresh;
}
