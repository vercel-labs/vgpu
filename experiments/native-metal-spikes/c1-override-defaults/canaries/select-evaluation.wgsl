override A: bool = false;
override N: u32 = select(2u, 4u, A);

@compute @workgroup_size(N)
fn main() {}
