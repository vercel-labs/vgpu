import { group, perspective, viewMatrices, type Mat4 } from 'vgpu/scene';

export interface CameraOptions {
  readonly position: ArrayLike<number>;
  readonly target: ArrayLike<number>;
  readonly up?: ArrayLike<number>;
  readonly fov: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

export interface CameraMatrices {
  readonly position: Float32Array;
  readonly projection: Mat4;
  readonly view: Mat4;
  readonly viewProjection: Mat4;
}

export function cameraMatrices(options: CameraOptions): CameraMatrices {
  const node = group({ position: options.position }).lookAt(options.target, options.up);
  const position = new Float32Array(node.worldPosition);
  const projection = perspective(
    { fov: options.fov, near: options.near, far: options.far },
    options.aspect,
    new Float32Array(16),
  );
  const matrices = {
    view: new Float32Array(16),
    viewProjection: new Float32Array(16),
  };
  viewMatrices({ position, quaternion: new Float32Array(node.quaternion) }, projection, matrices);
  return { position, projection, ...matrices };
}
