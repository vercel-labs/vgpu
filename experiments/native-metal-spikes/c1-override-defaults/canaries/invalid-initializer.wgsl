override X: u32 = 0u;
override A: u32 = 4u / X;

@compute @workgroup_size(A)
fn main() {}
