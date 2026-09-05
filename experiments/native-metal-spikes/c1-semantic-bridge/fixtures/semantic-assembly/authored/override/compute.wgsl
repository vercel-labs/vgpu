@id(17) override REQUIRED: u32;
override DEP: u32 = REQUIRED + 1u;
override UNUSED: u32 = 11u;

@compute @workgroup_size(DEP)
fn needs_required() {}
