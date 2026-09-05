enable f16;

override A_BOOL: bool = true;
override B_I32: i32 = -2;
override C_U32: u32 = 3u;
override D_F16: f16 = 1.5h;
override E_F32: f32 = -0.0f;

@compute @workgroup_size(C_U32)
fn all_scalars() {
  let scalar_sum = f32(B_I32) + f32(C_U32) + f32(D_F16) + E_F32;
  if A_BOOL {
    _ = scalar_sum;
  }
}
