import { degToRad, perspectiveCamera, type Camera, type Vec3 } from "../../../src/scene/geometry-src/index.ts";

export type PrimitiveCameraAngle = "front" | "iso" | "side";

const POSITIONS = {
  front: [0, 0.5, 3],
  iso: [2, 2, 3],
  side: [3, 0.75, 0.25],
} as const;

export function primitiveCamera(angle: PrimitiveCameraAngle): Camera {
  return perspectiveCamera({
    fovYRadians: degToRad(45),
    aspect: 1,
    near: 0.1,
    far: 100,
    position: vec3(POSITIONS[angle]),
    target: vec3([0, 0, 0]),
  });
}

function vec3(values: readonly [number, number, number]): Vec3 {
  return new Float32Array(values) as Vec3;
}
