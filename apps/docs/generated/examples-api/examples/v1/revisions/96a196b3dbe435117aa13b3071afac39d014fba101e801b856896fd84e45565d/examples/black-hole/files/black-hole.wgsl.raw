struct Params {
  resolution: vec2f,
  pointer: vec2f,
  time: f32,
}

@group(0) @binding(0) var<uniform> params: Params;

const PI: f32 = 3.14159265359;
const HORIZON: f32 = 1.0;
const ISCO: f32 = 3.0;
const DISK_OUTER: f32 = 9.5;

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += vec2f(dot(q, q + vec2f(45.32)));
  return fract(q.x * q.y);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
             mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x), u.y);
}

fn fbm(p0: vec2f) -> f32 {
  var p = p0;
  var value = 0.0;
  var amplitude = 0.5;
  for (var i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p = mat2x2f(1.6, 1.2, -1.2, 1.6) * p;
    amplitude *= 0.5;
  }
  return value;
}

fn geodesicAcceleration(position: vec3f, velocity: vec3f) -> vec3f {
  let r2 = dot(position, position);
  let angularMomentum = cross(position, velocity);
  let h2 = dot(angularMomentum, angularMomentum);
  return -1.5 * h2 * position / (r2 * r2 * sqrt(r2));
}

fn starField(direction: vec3f) -> vec3f {
  let d = normalize(direction);
  let spherical = vec2f(atan2(d.z, d.x) / (2.0 * PI), asin(clamp(d.y, -1.0, 1.0)) / PI);
  let grid = spherical * vec2f(720.0, 360.0);
  let cell = floor(grid);
  let local = fract(grid) - 0.5;
  let seed = hash21(cell);
  let radius = mix(0.02, 0.07, seed * seed);
  let point = smoothstep(radius, 0.0, length(local)) * step(0.986, seed);
  let glow = smoothstep(radius * 4.0, 0.0, length(local)) * step(0.997, seed) * 0.35;
  let temperature = hash21(cell + vec2f(17.0, 29.0));
  let tint = mix(vec3f(0.48, 0.65, 1.0), vec3f(1.0, 0.72, 0.42), temperature);
  return tint * (point * (1.5 + seed * 3.0) + glow);
}

fn volumeSample(point: vec3f, rayVelocity: vec3f) -> vec4f {
  let radius = length(point.xz);
  let height = abs(point.y);
  if (radius <= ISCO || radius >= DISK_OUTER || height > 0.42) { return vec4f(0.0); }

  // Rotated Cartesian turbulence avoids a polar branch-cut seam.
  let omega = 0.42 / pow(radius, 1.5);
  let swirl = 2.2 * log(radius);
  let ang = params.time * omega + swirl;
  let c = cos(ang);
  let s = sin(ang);
  let rc = vec2f(c * point.x - s * point.z, s * point.x + c * point.z);
  let broad = fbm(rc * 0.9 + vec2f(0.0, params.time * 0.02));
  let detail = fbm(rc * 2.6 + broad * 1.5);
  let rings = 0.5 + 0.5 * sin(radius * 8.5 + broad * 6.0);
  let clumps = smoothstep(0.26, 0.84, broad * 0.72 + detail * 0.46 + rings * 0.22);

  let thickness = mix(0.05, 0.24, smoothstep(ISCO, DISK_OUTER, radius));
  let vertical = exp(-pow(height / thickness, 2.0) * 3.4);
  let innerFade = smoothstep(ISCO, ISCO + 0.45, radius);
  let outerFade = 1.0 - smoothstep(DISK_OUTER - 2.4, DISK_OUTER, radius);
  let radial = (DISK_OUTER - radius) / (DISK_OUTER - ISCO);
  let radialFalloff = pow(radial, 0.36);
  let density = vertical * innerFade * outerFade * radialFalloff * clumps;

  let heat = pow(radial, 1.35);
  var thermal = mix(vec3f(0.55, 0.14, 0.03), vec3f(1.0, 0.55, 0.16), smoothstep(0.05, 0.55, heat));
  thermal = mix(thermal, vec3f(1.0, 0.94, 0.82), pow(heat, 2.4));

  let tangent = normalize(vec3f(-point.z, 0.0, point.x));
  let orbitalSpeed = min(0.64, 0.94 / sqrt(max(radius - HORIZON, 0.25)));
  let towardObserver = dot(tangent, -normalize(rayVelocity));
  // Gentle Doppler beaming keeps the threshold bloom nearly symmetric.
  let doppler = pow(clamp(1.0 / (1.0 - orbitalSpeed * towardObserver), 0.72, 1.55), 1.5);
  let gravitationalRedshift = sqrt(1.0 - HORIZON / radius);
  let emission = thermal * density * doppler * gravitationalRedshift * 9.5;
  return vec4f(emission, density * 2.1);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = params.resolution.x / params.resolution.y;
  let screen = (uv * 2.0 - 1.0) * vec2f(aspect, 1.0);

  let yaw = params.pointer.x;
  let pitch = clamp(params.pointer.y, -1.319, 1.319);
  let orbitRadius = 21.0;
  let cameraPosition = vec3f(
    sin(yaw) * cos(pitch) * orbitRadius,
    sin(pitch) * orbitRadius,
    cos(yaw) * cos(pitch) * orbitRadius,
  );
  let forward = normalize(-cameraPosition);
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = cross(right, forward);

  var position = cameraPosition;
  var velocity = normalize(forward * 1.72 + right * screen.x + up * screen.y);
  var accumulated = vec3f(0.0);
  var transmittance = 1.0;
  var escaped = false;

  for (var stepIndex = 0; stepIndex < 256; stepIndex++) {
    let radius = length(position);
    if (radius < HORIZON * 1.015) { break; }
    if (radius > 24.0 && stepIndex > 24 && dot(position, velocity) > 0.0) {
      escaped = true; break;
    }

    // Step finer near the horizon where the geodesic curves hardest.
    var stepSize = clamp((radius - HORIZON) * 0.07, 0.016, 0.24);

    // Cap steps near the thin disk so rays cannot skip its slab.
    let rxz = length(position.xz);
    if (rxz > ISCO - 0.6 && rxz < DISK_OUTER + 0.6) {
      let slab = mix(0.05, 0.24, smoothstep(ISCO, DISK_OUTER, rxz));
      let vy = max(abs(velocity.y), 0.001);
      let band = slab * 3.0;
      let ay = abs(position.y);
      if (ay < band) {
        stepSize = min(stepSize, (slab * 0.4) / vy);
      } else if (position.y * velocity.y < 0.0) {
        stepSize = min(stepSize, (ay - band) / vy);
      }
      stepSize = max(stepSize, 0.004);
    }

    let previousPosition = position;

    let acceleration0 = geodesicAcceleration(position, velocity);
    velocity += acceleration0 * (0.5 * stepSize);
    position += velocity * stepSize;
    let acceleration1 = geodesicAcceleration(position, velocity);
    velocity += acceleration1 * (0.5 * stepSize);
    velocity = normalize(velocity);

    let samplePoint = mix(previousPosition, position, 0.5);
    let volume = volumeSample(samplePoint, velocity);
    if (volume.a > 0.0001 && transmittance > 0.008) {
      let opticalDepth = volume.a * stepSize;
      let absorbed = 1.0 - exp(-opticalDepth);
      accumulated += volume.rgb * transmittance * absorbed / max(volume.a, 0.001);
      transmittance *= exp(-opticalDepth);
    }
  }

  if (escaped) { accumulated += starField(velocity) * transmittance; }

  // Linear HDR output; tone mapping and bloom happen in the post pipeline.
  return vec4f(accumulated, 1.0);
}
