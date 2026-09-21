import { linearToSrgb3 } from "@vgpu/wgsl-std/color";
import { applyPrismToneMapping } from "../../pipelines/shared/presentation/tone-mapping.wgsl";

struct PreviewParams {
  mode: u32,
  toneMapping: u32,
  exposure: f32,
  differenceGain: f32,
};

@group(0) @binding(0) var primaryTexture: texture_2d<f32>;
@group(0) @binding(1) var secondaryTexture: texture_2d<f32>;
@group(0) @binding(2) var previewSampler: sampler;
@group(0) @binding(3) var<uniform> params: PreviewParams;

@fragment
fn fs_preview(@location(0) uv: vec2f) -> @location(0) vec4f {
  let primary = textureSampleLevel(primaryTexture, previewSampler, uv, 0.0).rgb;
  let secondary = textureSampleLevel(secondaryTexture, previewSampler, uv, 0.0).rgb;
  var linear = max(primary, vec3f(0.0)) * params.exposure;
  if (params.mode == 1u) {
    linear = abs(primary - secondary) * params.differenceGain;
  }
  return vec4f(
    linearToSrgb3(applyPrismToneMapping(linear, params.toneMapping)),
    1.0,
  );
}
