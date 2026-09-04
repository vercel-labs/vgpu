override Y: u32 = 3u;
override UNUSED: u32 = 99u;
override X: u32 = 2u;

@compute @workgroup_size(X + Y)
fn sum() {}
