// Builds a model input by sampling the camera texture through a rotated ROI,
// writing NHWC float32 straight into a storage buffer that ONNX Runtime Web
// consumes as a tensor without ever touching the CPU.
//
// This shader is BOTH model inputs. The palm detector's 192x192 letterbox is
// just an unrotated ROI centred on the frame whose side is the frame's long
// edge — the black padding falls out of the same out-of-bounds rule a rotated
// crop already needs — and the landmark model's 224x224 hand crop is the general
// case. One transform, so the two stages cannot drift apart.
//
// The ROI is read from a GPU buffer rather than a uniform, and that is the whole
// trick that keeps tracked frames off the CPU. On a tracked frame the ROI was
// written by `hand.wgsl` from the *previous* frame's landmarks, so the host never
// learns where the hand is and never has to. It only writes an ROI on the rare
// reacquisition frame, and slot ROI_DETECTOR once when the camera resolution
// changes.
//
// Sampling is bilinear with clamp-to-edge, matching `cropToNhwcFloat32` in
// hand-preprocess.ts, which the tests compare against. Clamping rather than
// wrapping matters at the frame border: a hand at the edge produces a crop whose
// corners fall outside, and wrapping would fold the far side of the room in.

struct Roi {
  /// Centre in source pixels.
  center: vec2f,
  /// Side length in source pixels.
  size: f32,
  /// Radians. Rotates the crop so the hand stands upright for the model.
  rotation: f32,
};

struct CropUniforms {
  /// Camera frame size in pixels.
  source: vec2f,
  /// Output side in model pixels: 192 for the detector, 224 for a hand crop.
  out_size: f32,
  /// Which ROI slot to crop; see ROI_DETECTOR below.
  roi_index: u32,
};

/// Two hand slots plus one fixed entry for the detector's full-frame letterbox.
/// Spelled as a literal because vgpu's auto-layout reflection requires one
/// (VGPU-WGSL-REFLECT-ARRAY-LENGTH).
const ROI_SLOT_COUNT: u32 = 3u;

@group(0) @binding(0) var<uniform> crop: CropUniforms;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<storage, read> rois: array<Roi, 3>;
@group(0) @binding(4) var<storage, read_write> out_buf: array<f32>;

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let size = u32(crop.out_size);
  if (gid.x >= size || gid.y >= size) {
    return;
  }
  let roi = rois[min(crop.roi_index, ROI_SLOT_COUNT - 1u)];

  // Crop-normalized [0,1]^2, sampled at texel centres.
  let uv = (vec2f(f32(gid.x), f32(gid.y)) + vec2f(0.5)) / crop.out_size;
  let c = cos(roi.rotation);
  let s = sin(roi.rotation);
  let d = (uv - vec2f(0.5)) * roi.size;
  // Identical expression to `cropToSource` in hand-pipeline.ts.
  let source_px = roi.center + vec2f(d.x * c - d.y * s, d.x * s + d.y * c);

  var rgb = vec3f(0.0);
  // Outside the frame is black. MediaPipe's border mode, and what makes the
  // detector's letterbox padding appear without a special case.
  if (all(source_px >= vec2f(0.0)) && all(source_px < crop.source)) {
    rgb = textureSampleLevel(src, samp, source_px / crop.source, 0.0).rgb;
  }

  // NHWC, channels fastest: the layout both graphs declare.
  let base = (gid.y * size + gid.x) * 3u;
  out_buf[base] = rgb.r;
  out_buf[base + 1u] = rgb.g;
  out_buf[base + 2u] = rgb.b;
}
