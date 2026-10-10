export fn instanceWorldMatrix(world0: vec4f, world1: vec4f, world2: vec4f, world3: vec4f) -> mat4x4f {
  return mat4x4f(world0, world1, world2, world3);
}

export fn transformPosition(world: mat4x4f, position: vec3f) -> vec3f {
  return (world * vec4f(position, 1.0)).xyz;
}

export fn transformDirection(world: mat4x4f, direction: vec3f) -> vec3f {
  return (world * vec4f(direction, 0.0)).xyz;
}

export fn transformNormal(world: mat4x4f, normal: vec3f) -> vec3f {
  let linear0 = world[0].xyz;
  let linear1 = world[1].xyz;
  let linear2 = world[2].xyz;
  let normalMagnitude = abs(normal);
  let normalScale = max(max(normalMagnitude.x, normalMagnitude.y), normalMagnitude.z);
  if (normalScale == 0.0) {
    return vec3f(0.0);
  }

  let linearMagnitude = max(max(abs(linear0), abs(linear1)), abs(linear2));
  let linearScale = max(max(linearMagnitude.x, linearMagnitude.y), linearMagnitude.z);
  if (linearScale == 0.0) {
    return vec3f(0.0);
  }

  let scaled0 = linear0 / linearScale;
  let scaled1 = linear1 / linearScale;
  let scaled2 = linear2 / linearScale;
  let cofactor0 = cross(scaled1, scaled2);
  let cofactor1 = cross(scaled2, scaled0);
  let cofactor2 = cross(scaled0, scaled1);
  let determinant = dot(scaled0, cofactor0);
  if (determinant == 0.0) {
    return vec3f(0.0);
  }

  let scaledNormal = normal / normalScale;
  let cofactorNormal = scaledNormal.x * cofactor0 + scaledNormal.y * cofactor1 + scaledNormal.z * cofactor2;
  let cofactorMagnitude = abs(cofactorNormal);
  let cofactorScale = max(max(cofactorMagnitude.x, cofactorMagnitude.y), cofactorMagnitude.z);
  if (cofactorScale == 0.0) {
    return vec3f(0.0);
  }

  let scaledCofactorNormal = cofactorNormal / cofactorScale;
  let result = scaledCofactorNormal * inverseSqrt(dot(scaledCofactorNormal, scaledCofactorNormal));
  if (determinant < 0.0) {
    return -result;
  }
  return result;
}
