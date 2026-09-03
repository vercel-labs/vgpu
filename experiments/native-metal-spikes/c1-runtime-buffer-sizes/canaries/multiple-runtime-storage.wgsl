struct A {
  values: array<u32>,
}

struct B {
  prefix: u32,
  values: array<vec2u>,
}

struct C {
  prefix: vec4u,
  values: array<vec3u>,
}

struct D {
  values: array<mat2x2f>,
}

struct E {
  prefix: array<u32, 5>,
  values: array<u32>,
}

struct Result {
  values: array<u32, 10>,
}

@group(2) @binding(9) var<storage, read> a: A;
@group(0) @binding(7) var<storage, read> b: B;
@group(3) @binding(1) var<storage, read> c: C;
@group(0) @binding(0) var<storage, read> d: D;
@group(1) @binding(4) var<storage, read> e: E;
@group(0) @binding(1) var<storage, read_write> result: Result;

@compute @workgroup_size(1) fn main() {
  result.values[0] = arrayLength(&d.values);
  result.values[1] = arrayLength(&b.values);
  result.values[2] = arrayLength(&e.values);
  result.values[3] = arrayLength(&a.values);
  result.values[4] = arrayLength(&c.values);
  result.values[5] = bitcast<u32>(d.values[0][0].x);
  result.values[6] = b.values[0].x;
  result.values[7] = e.values[0];
  result.values[8] = a.values[0];
  result.values[9] = c.values[0].x;
}
