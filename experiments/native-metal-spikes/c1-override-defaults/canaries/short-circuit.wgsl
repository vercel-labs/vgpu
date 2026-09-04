override REQUIRED: bool;
override FOLDED: bool = false && REQUIRED;

@compute @workgroup_size(1)
fn main() {
  if FOLDED {}
}
