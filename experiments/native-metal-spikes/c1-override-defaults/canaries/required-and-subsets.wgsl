override REQUIRED: u32;
override DEP: u32 = REQUIRED + 1u;
override FIRST: u32 = 2u;
override SECOND: u32 = 3u;

@compute @workgroup_size(DEP)
fn needs_required() {}

@compute @workgroup_size(FIRST)
fn first() {}

@compute @workgroup_size(SECOND)
fn second() {}
