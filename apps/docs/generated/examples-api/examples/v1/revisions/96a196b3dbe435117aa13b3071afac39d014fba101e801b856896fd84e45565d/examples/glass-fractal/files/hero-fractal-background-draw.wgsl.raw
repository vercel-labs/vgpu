import {
  HeroFloorAoSettings,
  heroFloorAo,
} from "./hero-fractal-floor-ao.wgsl";
import { presentCeramic } from "./hero-fractal-presentation.wgsl";

const HERO_FLOOR_Y = -0.33333333333;

struct Params {
  resolution: vec2f,
  tanHalfFov: f32,
  cameraPosition: vec3f,
  cameraTarget: vec3f,
  cameraUp: vec3f,
  floorGrid: f32,
  fractalScale: f32,
  orbScale: f32,
  sphereMix: f32,
  glassAoScale: f32,
  glassAoAmplitude: f32,
  glassAoOpacity: f32,
  fractalAoScale: f32,
  fractalAoAmplitude: f32,
  fractalAoOpacity: f32,
  orbAoScale: f32,
  orbAoAmplitude: f32,
  orbAoOpacity: f32,
}
@group(0) @binding(0) var<uniform> params: Params;

struct VertexOut {
  @builtin(position) position: vec4f,
}

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VertexOut {
  let positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  var out: VertexOut;
  out.position = vec4f(positions[index], 0.0, 1.0);
  return out;
}

fn cameraRay(uv: vec2f) -> vec3f {
  let forward = normalize(params.cameraTarget - params.cameraPosition);
  let right = normalize(cross(forward, params.cameraUp));
  let up = normalize(cross(right, forward));
  let aspect = params.resolution.x / max(params.resolution.y, 1.0);
  var screen = uv * 2.0 - 1.0;
  screen.y = -screen.y;
  let localRay = normalize(vec3f(
    screen.x * aspect * params.tanHalfFov,
    screen.y * params.tanHalfFov,
    -1.0,
  ));
  return normalize(mat3x3f(right, up, -forward) * localRay);
}

fn gridLine(coordinate: vec2f, spacing: f32, pixelFootprint: f32) -> f32 {
  let gridCoordinate = coordinate / spacing;
  let distanceToLine = abs(fract(gridCoordinate - 0.5) - 0.5);
  let distance = min(distanceToLine.x, distanceToLine.y);
  let width = clamp(pixelFootprint / spacing, 0.0005, 0.45);
  return 1.0 - smoothstep(width * 0.35, width, distance);
}

@fragment fn fs_main(in: VertexOut) -> @location(0) vec4f {
  let uv = in.position.xy / max(params.resolution, vec2f(1.0));
  let ro = params.cameraPosition;
  let rd = cameraRay(uv);
  // `presentCeramic` maps the neutral linear value to #fafafa. A broad,
  // screen-space top-right vignette gives the glass a little more contrast,
  // while fading completely before the bottom edge so the hero still meets
  // the rest of the page without a seam.
  let cornerDistance = length(vec2f(
    (uv.x - 0.95) * 0.85,
    uv.y * 1.15,
  ));
  let topRightShade = 1.0 - smoothstep(0.08, 1.0, cornerDistance);
  let backdrop = vec3f(2.93) * mix(1.0, 0.46, topRightShade);
  if (rd.y < -0.0001) {
    let floorT = (HERO_FLOOR_Y - ro.y) / rd.y;
    if (floorT > 0.0) {
      let floorPoint = ro + rd * floorT;
      let floorAoSettings = HeroFloorAoSettings(
        params.glassAoScale,
        params.glassAoAmplitude,
        params.glassAoOpacity,
        params.fractalAoScale,
        params.fractalAoAmplitude,
        params.fractalAoOpacity,
        params.orbAoScale,
        params.orbAoAmplitude,
        params.orbAoOpacity,
      );
      let floorAo = heroFloorAo(
        floorPoint.xz,
        params.fractalScale,
        params.orbScale,
        params.sphereMix,
        floorAoSettings,
      );
      var floorColor = backdrop;
      if (params.floorGrid > 0.5) {
        let pixelFootprint = max(
          floorT * params.tanHalfFov * 3.2 / max(params.resolution.y, 1.0),
          0.0001,
        );
        let minor = gridLine(floorPoint.xz, 0.25, pixelFootprint) * 0.62;
        let major = gridLine(floorPoint.xz, 1.0, pixelFootprint) * 0.90;
        let grid = max(minor, major);
        floorColor = mix(floorColor, vec3f(0.035), grid);
      }
      let presentedFloor = presentCeramic(floorColor);
      return vec4f(presentedFloor.rgb * floorAo, presentedFloor.a);
    }
  }
  return presentCeramic(backdrop);
}
