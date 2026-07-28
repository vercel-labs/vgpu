struct Paint {
  from: vec2f,
  to: vec2f,
};

@fragment fn main() -> @location(0) vec4f {
  var paint: Paint;
  return vec4f(paint.from, paint.to);
}
