import { mat4 } from "wgpu-matrix";
import type { Camera, Vec3 } from "./camera.ts";

const DEFAULT_UP = new Float32Array([0, 1, 0]) as Vec3;

export interface PerspectiveCameraSpec {
  fovYRadians: number;
  aspect: number;
  near: number;
  far: number;
  position: Vec3;
  target: Vec3;
  up?: Vec3;
}

export function perspectiveCamera(spec: PerspectiveCameraSpec): Camera {
  const projection = mat4.perspective(spec.fovYRadians, spec.aspect, spec.near, spec.far);
  const view = mat4.lookAt(spec.position, spec.target, spec.up ?? DEFAULT_UP);
  const viewProjectionMatrix = new Float32Array(mat4.multiply(projection, view)) as Camera["viewProjectionMatrix"];
  const position = new Float32Array(spec.position) as Vec3;

  return Object.freeze({ viewProjectionMatrix, position });
}
