import { pcg2d, pcg3d, unitFloat } from "@vgpu/wgsl-std/hash";

export struct VoronoiSample2 {
  f1: f32,
  f2: f32,
  cell: vec2i,
}

export struct VoronoiSample3 {
  f1: f32,
  f2: f32,
  cell: vec3i,
}

export fn voronoi2d(position: vec2f) -> VoronoiSample2 {
  let baseCell = vec2i(floor(position));
  var nearestDistance = 3.4028235e38;
  var secondDistance = 3.4028235e38;
  var nearestCell = baseCell;

  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      let cell = baseCell + vec2i(x, y);
      let hashed = pcg2d(bitcast<vec2u>(cell));
      let feature = vec2f(f32(cell.x), f32(cell.y)) + vec2f(unitFloat(hashed.x), unitFloat(hashed.y));
      let distance = length(feature - position);

      if (distance < nearestDistance) {
        secondDistance = nearestDistance;
        nearestDistance = distance;
        nearestCell = cell;
      } else if (distance < secondDistance) {
        secondDistance = distance;
      }
    }
  }

  return VoronoiSample2(nearestDistance, secondDistance, nearestCell);
}

export fn voronoi3d(position: vec3f) -> VoronoiSample3 {
  let baseCell = vec3i(floor(position));
  var nearestDistance = 3.4028235e38;
  var secondDistance = 3.4028235e38;
  var nearestCell = baseCell;

  for (var z = -1; z <= 1; z = z + 1) {
    for (var y = -1; y <= 1; y = y + 1) {
      for (var x = -1; x <= 1; x = x + 1) {
        let cell = baseCell + vec3i(x, y, z);
        let hashed = pcg3d(bitcast<vec3u>(cell));
        let feature = vec3f(f32(cell.x), f32(cell.y), f32(cell.z)) + vec3f(unitFloat(hashed.x), unitFloat(hashed.y), unitFloat(hashed.z));
        let distance = length(feature - position);

        if (distance < nearestDistance) {
          secondDistance = nearestDistance;
          nearestDistance = distance;
          nearestCell = cell;
        } else if (distance < secondDistance) {
          secondDistance = distance;
        }
      }
    }
  }

  return VoronoiSample3(nearestDistance, secondDistance, nearestCell);
}
