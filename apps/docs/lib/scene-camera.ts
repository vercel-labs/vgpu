import {
  group,
  perspective,
  viewMatrices,
  type Lens,
  type Mat4,
  type Pose,
} from "vgpu/scene";

type Vec3Input = ArrayLike<number>;

export interface CameraStateOptions {
  readonly position: Vec3Input;
  readonly target: Vec3Input;
  readonly up?: Vec3Input;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

export interface CameraStateUpdate {
  readonly position?: Vec3Input;
  readonly target?: Vec3Input;
  readonly up?: Vec3Input;
  readonly fov?: number;
  readonly aspect?: number;
  readonly near?: number;
  readonly far?: number;
}

export interface CameraState extends Pose {
  readonly target: Float32Array;
  readonly up: Float32Array;
  readonly lens: Lens;
  aspect: number;
  readonly projection: Mat4;
  readonly view: Mat4;
  readonly viewProjection: Mat4;
}

export function createCameraState(options: CameraStateOptions): CameraState {
  const camera: CameraState = {
    position: copyVec3(options.position),
    quaternion: new Float32Array(4),
    target: copyVec3(options.target),
    up: copyVec3(options.up ?? [0, 1, 0]),
    lens: { fov: options.fov, near: options.near, far: options.far },
    aspect: options.aspect,
    projection: new Float32Array(16),
    view: new Float32Array(16),
    viewProjection: new Float32Array(16),
  };
  recompute(camera);
  return camera;
}

export function updateCameraState(camera: CameraState, values: CameraStateUpdate): CameraState {
  if (values.position !== undefined) camera.position.set(copyVec3(values.position));
  if (values.target !== undefined) camera.target.set(copyVec3(values.target));
  if (values.up !== undefined) camera.up.set(copyVec3(values.up));
  if (values.fov !== undefined) camera.lens.fov = values.fov;
  if (values.near !== undefined) camera.lens.near = values.near;
  if (values.far !== undefined) camera.lens.far = values.far;
  if (values.aspect !== undefined) camera.aspect = values.aspect;
  recompute(camera);
  return camera;
}

function recompute(camera: CameraState): void {
  const node = group({ position: camera.position }).lookAt(camera.target, camera.up);
  camera.quaternion.set(node.quaternion);
  perspective(camera.lens, camera.aspect, camera.projection);
  viewMatrices(camera, camera.projection, camera);
}

function copyVec3(value: Vec3Input): Float32Array {
  return new Float32Array([value[0]!, value[1]!, value[2]!]);
}
