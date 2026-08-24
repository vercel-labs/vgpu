// Minimal complex-number helpers (complex value packed as vec2f = re + i*im).
// Pure module: only exported functions.

export fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

export fn cconj(a: vec2f) -> vec2f {
  return vec2f(a.x, -a.y);
}

// e^{i*theta} = (cos theta, sin theta)
export fn cexp(theta: f32) -> vec2f {
  return vec2f(cos(theta), sin(theta));
}
