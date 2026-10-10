import { group, perspective, viewMatrices, type Mat4 } from "vgpu/scene";

export interface TestCamera {
  readonly position: Float32Array;
  readonly view: Mat4;
  readonly projection: Mat4;
  readonly viewProjection: Mat4;
}

export function testCamera(position: ArrayLike<number>, target: ArrayLike<number> = [0, 0, 0]): TestCamera {
  const node = group({ position }).lookAt(target);
  const ownedPosition = new Float32Array(node.worldPosition);
  const projection = perspective(
    { fov: 45, near: 0.1, far: 100 },
    1,
    new Float32Array(16),
  );
  const matrices = {
    view: new Float32Array(16),
    viewProjection: new Float32Array(16),
  };
  viewMatrices(
    { position: ownedPosition, quaternion: new Float32Array(node.quaternion) },
    projection,
    matrices,
  );
  return { position: ownedPosition, projection, ...matrices };
}
