override SHARED: u32 = 2u;
override FIRST: u32 = SHARED + 1u;
override SECOND: u32 = SHARED + 2u;

@compute @workgroup_size(FIRST)
fn first() {}

@compute @workgroup_size(SECOND)
fn second() {}
