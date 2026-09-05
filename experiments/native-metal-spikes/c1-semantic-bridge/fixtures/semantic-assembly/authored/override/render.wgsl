override SHARED: f32 = 0.25f;
override VERTEX_ONLY: f32 = 0.5f;
override FRAGMENT_ONLY: f32 = 0.75f;

@vertex fn vs_main() -> @builtin(position) vec4f {
  return vec4f(VERTEX_ONLY + SHARED, 0.0, 0.0, 1.0);
}

@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(FRAGMENT_ONLY, SHARED, 0.0, 1.0);
}
