// Bakes the matcap itself: a sphere lit head-on, stored so that the texel at a
// given offset from the disk center holds the color of a surface whose
// view-space normal points that way. Every light in this file is evaluated once
// at startup and never again.

const BASE = vec3f(0.05, 0.068, 0.1);
const SKY = vec3f(0.4, 0.6, 0.95);
const KEY = vec3f(1.0, 0.93, 0.78);
const KEY_DIRECTION = vec3f(-0.42, 0.72, 0.55);
const FILL_DIRECTION = vec3f(0.68, -0.34, 0.42);
const VIEW = vec3f(0.0, 0.0, 1.0);

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Texture space runs top-down, so flipping v here is what puts +y up on the
  // baked ball. The lookup in matcap.wgsl flips it back exactly once.
  let disk = vec2f(uv.x, 1.0 - uv.y) * 2.0 - 1.0;
  let radius_squared = dot(disk, disk);
  // Outside the ball there is no normal to shade. Keeping the corners dark
  // means a stray fetch reads as unlit instead of as a bright seam.
  if (radius_squared > 1.0) {
    return vec4f(BASE * 0.4, 1.0);
  }

  // Reconstruct the sphere: the disk offset *is* the normal's xy.
  let normal = vec3f(disk, sqrt(1.0 - radius_squared));
  let key_direction = normalize(KEY_DIRECTION);

  // A softbox key, a cool bounce from below, and the room gradient a polished
  // surface would reflect - all folded into one texel.
  let key = pow(max(dot(normal, key_direction), 0.0), 1.6);
  let highlight = pow(max(dot(normal, normalize(key_direction + VIEW)), 0.0), 220.0);
  let fill = max(dot(normal, normalize(FILL_DIRECTION)), 0.0);
  let room = mix(BASE, SKY, smoothstep(-0.7, 0.9, reflect(-VIEW, normal).y));
  let rim = pow(1.0 - normal.z, 3.5);

  let color = room + KEY * (key * 0.5 + highlight * 3.0) + SKY * (fill * 0.16 + rim * 0.45);
  return vec4f(color, 1.0);
}
