// Samples either the detector letterbox or a rotated hand ROI directly into an
// NHWC float32 GPU buffer consumed by ONNX Runtime without CPU readback.

struct Roi {
  center: vec2f,
  size: f32,
  rotation: f32,
};

struct CropUniforms {
  source: vec2f,
  out_size: f32,
  roi_index: u32,
};

// Binding array lengths must be literals for vgpu reflection.
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

  let uv = (vec2f(f32(gid.x), f32(gid.y)) + vec2f(0.5)) / crop.out_size;
  let c = cos(roi.rotation);
  let s = sin(roi.rotation);
  let d = (uv - vec2f(0.5)) * roi.size;
  let source_px = roi.center + vec2f(d.x * c - d.y * s, d.x * s + d.y * c);

  var rgb = vec3f(0.0);
  // Out-of-frame samples form the detector's black letterbox padding.
  if (all(source_px >= vec2f(0.0)) && all(source_px < crop.source)) {
    rgb = textureSampleLevel(src, samp, source_px / crop.source, 0.0).rgb;
  }

  let base = (gid.y * size + gid.x) * 3u;
  out_buf[base] = rgb.r;
  out_buf[base + 1u] = rgb.g;
  out_buf[base + 2u] = rgb.b;
}
