// Directional environment used to audit reflection and refraction paths.
//
// The six dominant-axis faces deliberately have unrelated colors, matching the
// topology of a cubemap without requiring a texture. Three great-circle ribbons
// cross those face boundaries. Their colors come only from the global direction,
// so the center of every ribbon is continuous even where the face color changes.

const DEBUG_POSITIVE_X = vec3f(1.0, 0.16, 0.11);
const DEBUG_NEGATIVE_X = vec3f(0.05, 0.92, 0.92);
const DEBUG_POSITIVE_Y = vec3f(0.18, 1.0, 0.26);
const DEBUG_NEGATIVE_Y = vec3f(1.0, 0.12, 0.72);
const DEBUG_POSITIVE_Z = vec3f(0.14, 0.32, 1.0);
const DEBUG_NEGATIVE_Z = vec3f(1.0, 0.72, 0.06);

struct DebugFace {
  color: vec3f,
  /** WebGPU cubemap face coordinates: (0, 0) is the authored top-left. */
  uv: vec2f,
}

fn debugFace(direction: vec3f) -> DebugFace {
  let absolute = abs(direction);
  if (absolute.x >= absolute.y && absolute.x >= absolute.z) {
    let positive = direction.x >= 0.0;
    let facePosition = select(
      vec2f(direction.z, -direction.y),
      vec2f(-direction.z, -direction.y),
      positive,
    );
    return DebugFace(
      select(DEBUG_NEGATIVE_X, DEBUG_POSITIVE_X, positive),
      facePosition / absolute.x * 0.5 + 0.5,
    );
  }
  if (absolute.y >= absolute.z) {
    let positive = direction.y >= 0.0;
    let facePosition = select(
      vec2f(direction.x, -direction.z),
      vec2f(direction.x, direction.z),
      positive,
    );
    return DebugFace(
      select(DEBUG_NEGATIVE_Y, DEBUG_POSITIVE_Y, positive),
      facePosition / absolute.y * 0.5 + 0.5,
    );
  }
  let positive = direction.z >= 0.0;
  let facePosition = select(
    vec2f(-direction.x, -direction.y),
    vec2f(direction.x, -direction.y),
    positive,
  );
  return DebugFace(
    select(DEBUG_NEGATIVE_Z, DEBUG_POSITIVE_Z, positive),
    facePosition / absolute.z * 0.5 + 0.5,
  );
}

fn debugRibbonMask(distanceFromPlane: f32) -> f32 {
  return 1.0 - smoothstep(0.018, 0.035, abs(distanceFromPlane));
}

fn debugArrowMask(uv: vec2f) -> f32 {
  let point = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let shaft = (1.0 - smoothstep(0.05, 0.075, abs(point.x)))
    * smoothstep(-0.62, -0.54, point.y)
    * (1.0 - smoothstep(0.18, 0.25, point.y));
  let headWidth = max(0.0, (0.68 - point.y) * 0.72);
  let head = (1.0 - smoothstep(headWidth, headWidth + 0.025, abs(point.x)))
    * smoothstep(0.12, 0.18, point.y)
    * (1.0 - smoothstep(0.62, 0.68, point.y));
  return max(shaft, head);
}

/** Diagnostic radiance arriving from `direction`, in linear RGB. */
export fn sampleDebugEnvironment(directionInput: vec3f) -> vec3f {
  let direction = normalize(directionInput);
  let face = debugFace(direction);

  // This world-space ramp is independent of face-local UV. Negating direction.y
  // therefore reverses the lighting of all four side faces at once.
  let worldHeight = direction.y * 0.5 + 0.5;
  var color = face.color * (0.42 + worldHeight * 0.44) + vec3f(0.025);

  // Dark seams make the analytically selected cubemap face unambiguous.
  let edgeDistance = min(
    min(face.uv.x, 1.0 - face.uv.x),
    min(face.uv.y, 1.0 - face.uv.y),
  );
  let faceEdge = 1.0 - smoothstep(0.012, 0.026, edgeDistance);
  color = mix(color, vec3f(0.012), faceEdge * 0.78);

  // Each ribbon follows a great circle through both ends of its named axis.
  // Its gradient is derived from that world-space coordinate, not face-local UV,
  // which makes it a continuous reference across every cubemap seam it crosses.
  let xRibbon = debugRibbonMask(direction.y);
  let yRibbon = debugRibbonMask(direction.z);
  let zRibbon = debugRibbonMask(direction.x);
  let xGradient = mix(DEBUG_NEGATIVE_X, DEBUG_POSITIVE_X, direction.x * 0.5 + 0.5);
  let yGradient = mix(DEBUG_NEGATIVE_Y, DEBUG_POSITIVE_Y, direction.y * 0.5 + 0.5);
  let zGradient = mix(DEBUG_NEGATIVE_Z, DEBUG_POSITIVE_Z, direction.z * 0.5 + 0.5);

  color = mix(color, xGradient * 1.35 + vec3f(0.08), xRibbon * 0.92);
  color = mix(color, yGradient * 1.35 + vec3f(0.08), yRibbon * 0.92);
  color = mix(color, zGradient * 1.35 + vec3f(0.08), zRibbon * 0.92);

  // Face-local orientation legend. It is intentionally not symmetric under
  // either U or V inversion:
  //   top = white, bottom = black, left = cyan, right = orange.
  let top = 1.0 - smoothstep(0.035, 0.06, face.uv.y);
  let bottom = smoothstep(0.94, 0.965, face.uv.y);
  let left = 1.0 - smoothstep(0.035, 0.06, face.uv.x);
  let right = smoothstep(0.94, 0.965, face.uv.x);
  color = mix(color, vec3f(1.8), top * 0.96);
  color = mix(color, vec3f(0.004), bottom * 0.98);
  color = mix(color, vec3f(0.0, 1.4, 1.7), left * 0.94);
  color = mix(color, vec3f(1.8, 0.42, 0.02), right * 0.94);

  // A white upward arrow remains readable away from the face boundaries and
  // makes a vertical flip obvious even in a small internal reflection.
  color = mix(color, vec3f(1.8), debugArrowMask(face.uv) * 0.94);
  return color;
}
