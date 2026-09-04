enable f16;

const THREE: u32 = 3u;

override BASE: u32 = THREE + 1u;
override DEP: u32 = BASE * 2u;
override FLAG: bool = true;
override SIGNED: i32 = -7;
@id(17) override EXPLICIT: f32 = f32(THREE) / 2.0;
override F32_SUB: f32 = 0x1p-149f;
override F32_MAX: f32 = 0x1.fffffep+127f;
override F16_HALF: f16 = 0.5h;
override F16_SUB: f16 = 0x1p-24h;
override F16_MAX: f16 = 65504.0h;

@compute @workgroup_size(DEP)
fn main() {
  if FLAG && SIGNED < 0 && EXPLICIT > 0.0 && F32_SUB > 0.0 && F32_MAX > 0.0 &&
      F16_HALF > 0.0h && F16_SUB > 0.0h && F16_MAX > 0.0h {
    let keep_all_overrides_active = BASE;
    _ = keep_all_overrides_active;
  }
}
