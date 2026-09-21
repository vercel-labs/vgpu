struct Params {
  resolution: vec2f,
  tilt: vec2f,
  pointer: vec2f,
  hover: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var lettering: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;

fn roundedBox(p: vec2f, halfSize: vec2f, radius: f32) -> f32 {
  let q = abs(p) - halfSize + radius;
  return length(max(q, vec2f(0))) + min(max(q.x, q.y), 0.0) - radius;
}

fn segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let v = b - a;
  return length(p - a - v * clamp(dot(p - a, v) / dot(v, v), 0.0, 1.0));
}

fn stroke(distance: f32, width: f32, aa: f32) -> f32 {
  return 1.0 - smoothstep(width, width + aa, abs(distance));
}

// Approximate visible wavelengths in micrometers with smooth display RGB responses.
fn wavelengthColor(wavelength: f32) -> vec3f {
  let response = (vec3f(wavelength) - vec3f(0.610, 0.545, 0.460)) / vec3f(0.045, 0.038, 0.032);
  let visible = smoothstep(0.380, 0.410, wavelength) * (1.0 - smoothstep(0.700, 0.780, wavelength));
  return exp(-0.5 * response * response) * visible;
}

// Reflection grating approximation: m * wavelength = d * dot(L + V, across).
// L and V point away from the surface; across is perpendicular to the grooves.
// Based on the diffraction-order model in GPU Gems, chapter 8 (Jos Stam).
fn diffraction(across: vec2f, lightAndView: vec2f, spacing: f32) -> vec3f {
  let pathDifference = spacing * abs(dot(lightAndView, across));
  let along = dot(lightAndView, vec2f(-across.y, across.x));
  // Finite, imperfect groove patches broaden the directional reflection.
  let envelope = exp(-along * along / 0.36);
  var reflected = vec3f(0);
  for (var order = 1; order <= 3; order++) {
    let m = f32(order);
    reflected += wavelengthColor(pathDifference / m) / (m * m);
  }
  return reflected * envelope;
}

// Broad, art-directed pearlescence underneath the finer diffraction detail.
fn pearlColor(phase: f32) -> vec3f {
  return vec3f(0.55, 0.52, 0.64) + vec3f(0.43, 0.40, 0.34)
    * cos(6.2831853 * (phase + vec3f(0.05, 0.38, 0.63)));
}

fn grain(point: vec2f) -> f32 {
  let p = vec2u(abs(point) * 2400.0);
  var n = (p.x * 1597334677u) ^ (p.y * 3812015801u);
  n = (n ^ (n >> 16u)) * 2246822519u;
  return f32(n & 1023u) / 1023.0 - 0.5;
}

fn etchedPhase(p: vec2f) -> f32 {
  // Warp the surface before tracing contours, so their spacing flows in soft waves.
  let warp = vec2f(
    sin(p.y * 7.0 + sin(p.x * 4.0)) * 0.085,
    sin(p.x * 6.0 - p.y * 3.0) * 0.07
  );
  let q = p + warp - vec2f(0.13, 0.08);
  let radius = length(q * vec2f(1.0, 0.76));
  return radius * 142.0 + sin(atan2(q.y, q.x) * 3.0 + radius * 8.0) * 1.7;
}

// Signed edge distance inside an equilateral triangle centered at its centroid.
fn triangleBoundary(p: vec2f, height: f32) -> f32 {
  return max((abs(p.x) * sqrt(3.0) - p.y - height * (2.0 / 3.0)) * 0.5, p.y - height / 3.0);
}

fn triangleGrooves(edgeDistances: vec3f) -> vec2f {
  if (edgeDistances.x <= edgeDistances.y && edgeDistances.x <= edgeDistances.z) {
    return vec2f(0, -1);
  }
  if (edgeDistances.y <= edgeDistances.z) {
    return vec2f(-sqrt(3.0) * 0.5, 0.5);
  }
  return vec2f(sqrt(3.0) * 0.5, 0.5);
}

struct FractalMark {
  coverage: f32,
  across: vec2f,
}

// Recursive triangular engraving, with screen-space antialiasing at every scale.
fn fractalEngraving(p: vec2f, halfWidth: f32, height: f32, aa: f32) -> FractalMark {
  let apex = (height / 3.0 - p.y) / height;
  var barycentric = vec3f(apex, (1.0 - apex - p.x / halfWidth) * 0.5, (1.0 - apex + p.x / halfWidth) * 0.5);
  var cellHeight = height;
  for (var level = 0; level < 6; level++) {
    let largest = max(barycentric.x, max(barycentric.y, barycentric.z));
    if (largest < 0.5) {
      // Each removed central triangle leaves a fine foil border.
      return FractalMark(stroke((0.5 - largest) * cellHeight, 0.0008, aa * 0.65), triangleGrooves(0.5 - barycentric));
    }
    var corner = vec3f(0, 0, 1);
    if (barycentric.x >= barycentric.y && barycentric.x >= barycentric.z) {
      corner = vec3f(1, 0, 0);
    } else if (barycentric.y >= barycentric.z) {
      corner = vec3f(0, 1, 0);
    }
    barycentric = barycentric * 2.0 - corner;
    cellHeight *= 0.5;
  }
  let leafEdge = min(barycentric.x, min(barycentric.y, barycentric.z)) * cellHeight;
  return FractalMark(stroke(leafEdge, 0.0006, aa * 0.5) * 0.65, triangleGrooves(barycentric));
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let resolution = max(params.resolution, vec2f(1));
  let scale = min(resolution.y, resolution.x * 1.35);
  let screen = (uv - 0.5) * resolution / scale * 2.5;
  let sx = sin(params.tilt.y);
  let cx = cos(params.tilt.y);
  let sy = sin(params.tilt.x);
  let cy = cos(params.tilt.x);
  let right = vec3f(cy, 0, -sy);
  let down = vec3f(sy * sx, cx, cy * sx);
  let normal = cross(right, down);
  let eye = vec3f(0, 0, 4.5);
  let ray = normalize(vec3f(screen, -4.5));
  let hit = eye - ray * (dot(eye, normal) / dot(ray, normal));
  let p = vec2f(dot(hit, right), dot(hit, down));
  let aa = max(length(fwidth(p)), 0.0006);
  let edge = roundedBox(p, vec2f(0.64, 0.91), 0.055);
  let silhouette = 1.0 - smoothstep(-aa, aa, edge);

  let halo = exp(-dot(screen, screen) * 0.8);
  var background = vec3f(0.027, 0.031, 0.038) + 0.009 * halo;
  let shadow = exp(-max(roundedBox(screen - vec2f(0.025, 0.06), vec2f(0.63, 0.9), 0.055), 0.0) * 22.0);
  background *= 1.0 - 0.7 * shadow;

  // Matte graphite remains dark; only the cursor's grazing light reveals the foil.
  let hover = clamp(params.hover, 0.0, 1.0);
  let lightCenter = params.pointer * vec2f(0.64, 0.91);
  let delta = p - lightCenter;
  let sweepDistance = delta.x * 0.72 + delta.y * 0.52 + sin(p.y * 4.0 + p.x * 3.0) * 0.08;
  let bandDistance = sweepDistance / 0.36;
  let lightBand = exp(-bandDistance * bandDistance);
  let glintDistance = sweepDistance / 0.085;
  let glint = exp(-glintDistance * glintDistance);
  let spotlight = exp(-dot(delta * vec2f(1.05, 0.72), delta * vec2f(1.05, 0.72)) * 2.6);
  let light = lightBand * spotlight * hover;
  let lightDirection = normalize(vec3f(lightCenter, 1.2) - hit);
  let viewDirection = normalize(eye - hit);
  let lightAndView = vec2f(dot(lightDirection + viewDirection, right), dot(lightDirection + viewDirection, down));
  let illumination = max(dot(normal, lightDirection), 0.0) * max(dot(normal, viewDirection), 0.0);
  let tint = vec3f(0.72, 0.76, 0.8);
  let noise = grain(p + vec2f(2));
  var color = vec3f(0.062, 0.068, 0.078) + 0.008 * (0.9 - p.y);
  // Fine, surface-locked grain catches the grazing reflection without animated static.
  color += noise * (0.022 + light * 0.085);
  color += light * (vec3f(0.045) + tint * 0.065);

  let halfWidth = 0.38;
  let triangleHeight = halfWidth * sqrt(3.0);
  let top = vec2f(0, -triangleHeight * (2.0 / 3.0));
  let left = vec2f(-halfWidth, triangleHeight / 3.0);
  let rightCorner = vec2f(halfWidth, triangleHeight / 3.0);
  let triangleDistance = min(segment(p, top, left), min(segment(p, left, rightCorner), segment(p, rightCorner, top)));
  let innerBoundary = triangleBoundary(p, triangleHeight);
  let outerScale = 1.12;
  let outerBoundary = triangleBoundary(p, triangleHeight * outerScale);
  let inside = 1.0 - smoothstep(-aa * 1.5, -aa * 0.5, innerBoundary);
  let outside = smoothstep(aa * 0.5, aa * 1.5, outerBoundary);

  // Separate engravings leave a clear graphite gap between the two outlines.
  let contour = etchedPhase(p);
  // Transform screen derivatives back into the card plane: microscopic grooves
  // follow the visible contours, but their 1.65um spacing is independent of zoom.
  let dx = dpdx(p);
  let dy = dpdy(p);
  let gradient = vec2f(dpdx(contour) * dy.y - dpdy(contour) * dx.y, dpdy(contour) * dx.x - dpdx(contour) * dy.x);
  let across = gradient / max(length(gradient), 0.00000001);
  let outerDiffraction = diffraction(across, lightAndView, 1.65) * illumination;
  let contours = stroke(sin(contour), 0.06, min(fwidth(contour), 1.0));
  let reveal = hover * (0.06 + 0.24 * spotlight + light * 1.15);
  let fractal = fractalEngraving(p, halfWidth, triangleHeight, aa);
  let innerDiffraction = diffraction(fractal.across, lightAndView, 1.35) * illumination;
  let pearlPhase = dot(lightAndView, vec2f(0.48, -0.32)) + p.y * 0.32 + contour * 0.003;
  let outerPearl = pearlColor(pearlPhase);
  let innerPearl = pearlColor(pearlPhase + dot(fractal.across, lightAndView) * 0.32 + 0.12);
  // Color washes over the material between etched lines, with a narrower silver
  // flash moving through it. Both layers respect the empty gap between outlines.
  let pearl = outerPearl * outside + innerPearl * inside;
  color += pearl * light * 0.24;
  color += (pearl * 0.5 + vec3f(0.5) * (inside + outside)) * glint * spotlight * hover * 0.12;
  let sparkle = pow(max(noise + 0.5, 0.0), 24.0) * glint * spotlight * hover;
  color += pearl * sparkle * 0.22;
  let outerFoil = vec3f(0.12, 0.14, 0.18) + outerPearl * 0.65 + outerDiffraction * 0.12;
  let innerFoil = vec3f(0.12, 0.14, 0.18) + innerPearl * 0.65 + innerDiffraction * 0.12;
  color += (contours * 0.65 * outside * outerFoil + fractal.coverage * inside * innerFoil) * reveal;

  // A delicate spectral echo stays clipped to the same engraving regions.
  let foilOffset = vec2f(0.007, -0.004) + params.tilt * 0.012;
  let foilPoint = p - foilOffset;
  let foilPhase = etchedPhase(foilPoint);
  let foilLines = stroke(sin(foilPhase), 0.025, min(fwidth(foilPhase), 1.0));
  let foilFractal = fractalEngraving(foilPoint, halfWidth, triangleHeight, aa);
  let echoDiffraction = diffraction(foilFractal.across, lightAndView, 1.35) * illumination;
  color += (foilLines * 0.65 * outside * (outerPearl + outerDiffraction * 0.2)
    + foilFractal.coverage * inside * (innerPearl + echoDiffraction * 0.2)) * reveal * 0.22;
  // Scale every vertex around the shared centroid, keeping the outer foil centered.
  let foilEdge = min(segment(p, top * outerScale, left * outerScale), min(segment(p, left * outerScale, rightCorner * outerScale), segment(p, rightCorner * outerScale, top * outerScale)));
  let foilAcross = triangleGrooves(vec3f(triangleHeight * outerScale / 3.0 - p.y,
    (p.y + triangleHeight * outerScale * (2.0 / 3.0) - p.x * sqrt(3.0)) * 0.5,
    (p.y + triangleHeight * outerScale * (2.0 / 3.0) + p.x * sqrt(3.0)) * 0.5));
  let foilTint = outerPearl * 0.8 + vec3f(0.2) + diffraction(foilAcross, lightAndView, 1.65) * illumination * 0.15;
  color += stroke(foilEdge, 0.0007, aa * 0.5) * foilTint * hover * (0.12 + light * 0.5);

  // Sparse microdots and registration ticks emerge in the surrounding foil.
  let grid = (fract((p + 1.0) * 20.0) - 0.5) / 20.0;
  let dots = stroke(length(grid), 0.0008, aa * 0.4);
  color += dots * outside * reveal * 0.17;
  let guide = abs(p) - vec2f(0.49, 0.37);
  let horizontal = stroke(guide.y, 0.0006, aa * 0.5) * (1.0 - smoothstep(0.012, 0.017, abs(guide.x)));
  let vertical = stroke(guide.x, 0.0006, aa * 0.5) * (1.0 - smoothstep(0.012, 0.017, abs(guide.y)));
  color += max(horizontal, vertical) * hover * (0.12 + light * 0.22);

  // Always-visible outline: its baseline contrast does not depend on hover or light.
  let outline = stroke(triangleDistance, 0.0012, aa * 0.65);
  color = mix(color, vec3f(0.29, 0.32, 0.36) + tint * light * 0.16, outline);

  // Real Geist lettering baked into a small mask shared by browser and Node.
  let artworkUv = p / vec2f(1.28, 1.82) + 0.5;
  let text = textureSampleLevel(lettering, linear, clamp(artworkUv, vec2f(0), vec2f(1)), 0.0).r;
  color = mix(color, vec3f(0.77, 0.79, 0.82), text);
  let mark = p - vec2f(0.505, -0.765);
  let crossMark = min(segment(mark, vec2f(-0.024, 0), vec2f(0.024, 0)), segment(mark, vec2f(0, -0.024), vec2f(0, 0.024)));
  color = mix(color, vec3f(0.48, 0.51, 0.55), stroke(crossMark, 0.0007, aa * 0.65));

  let rim = stroke(edge + 0.002, 0.0008, aa * 0.7);
  let rimLight = pow(max(0.0, 1.0 - length(delta) * 0.65), 3.0) * hover;
  color = mix(color, vec3f(0.25, 0.28, 0.32) + (outerPearl * 0.7 + tint * 0.3) * rimLight * 0.6, rim);
  return vec4f(mix(background, color, silhouette), 1);
}
