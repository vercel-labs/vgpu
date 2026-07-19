// Main scene 3D occluder pass. A vertex-buffer triangle is projected from a top-down ortho camera.
struct Camera { params: vec4f };
@group(0) @binding(0) var<uniform> camera: Camera;

struct VSOut { @builtin(position) pos: vec4f };

@vertex fn vs_main(@location(0) position: vec3f) -> VSOut {
  var out: VSOut;
  out.pos = vec4f(position.x / camera.params.x, -position.z, 0.0, 1.0);
  return out;
}

@fragment fn fs_main() -> @location(0) vec4f {
  let is_light_theme = camera.params.y;
  return vec4f(vec3f(is_light_theme * 4.0), 1.0);
}
