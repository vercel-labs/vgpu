import { tonemapAces, tonemapReinhard } from "@vgpu/wgsl-std/color";

fn tonemapNeutral(value: vec3f) -> vec3f {
  var color = max(value, vec3f(0.0));
  let startCompression = 0.76;
  let desaturation = 0.15;
  let lowest = min(color.r, min(color.g, color.b));
  let offset = select(0.04, lowest - 6.25 * lowest * lowest, lowest < 0.08);
  color -= vec3f(offset);

  let peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) {
    return color;
  }

  let distance = 1.0 - startCompression;
  let compressedPeak = 1.0 - distance * distance /
    (peak + distance - startCompression);
  color *= compressedPeak / max(peak, 0.0001);
  let amount = 1.0 - 1.0 /
    (desaturation * (peak - compressedPeak) + 1.0);
  return mix(color, vec3f(compressedPeak), amount);
}

export fn applyPrismToneMapping(value: vec3f, mode: u32) -> vec3f {
  let color = max(value, vec3f(0.0));
  if (mode == 1u) {
    return clamp(tonemapNeutral(color), vec3f(0.0), vec3f(1.0));
  }
  if (mode == 2u) {
    return clamp(tonemapReinhard(color), vec3f(0.0), vec3f(1.0));
  }
  if (mode == 3u) {
    return clamp(color, vec3f(0.0), vec3f(1.0));
  }
  return tonemapAces(color);
}
