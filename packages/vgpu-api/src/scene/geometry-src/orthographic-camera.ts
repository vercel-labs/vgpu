import type { CameraSource, Vec3 } from "./camera.ts";
import { orthographic, viewProjection } from "./camera-math.ts";

const DEFAULT_UP = new Float32Array([0, 1, 0]) as Vec3;

export interface OrthographicCameraSpec {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
  readonly near: number;
  readonly far: number;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up?: Vec3;
}

export function orthographicCamera(spec: OrthographicCameraSpec): CameraSource {
  const projection = orthographic(spec.left, spec.right, spec.bottom, spec.top, spec.near, spec.far);
  const viewProjectionMatrix = viewProjection(projection, spec.position, spec.target, spec.up ?? DEFAULT_UP) as CameraSource["viewProjectionMatrix"];
  const position = new Float32Array(spec.position) as Vec3;

  return Object.freeze({ viewProjectionMatrix, position });
}
