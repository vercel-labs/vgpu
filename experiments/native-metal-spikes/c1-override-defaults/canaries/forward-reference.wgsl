override A: u32 = B + 1u;
override B: u32 = 2u;

@compute @workgroup_size(A)
fn main() {}
