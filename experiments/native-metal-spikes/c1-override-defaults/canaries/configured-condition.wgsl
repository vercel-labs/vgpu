override CONDITION: bool = false;
override REQUIRED: bool;
override RESULT: bool = CONDITION && REQUIRED;

@compute @workgroup_size(1)
fn main() {
  if RESULT {}
}
