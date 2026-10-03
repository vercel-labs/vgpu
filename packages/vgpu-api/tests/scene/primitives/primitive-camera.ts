import { group, perspective, viewMatrices, type Mat4 } from "../../../src/scene.ts";

export type PrimitiveCameraAngle = "front" | "iso" | "side";

const POSITIONS = {
  front: [0, 0.5, 3],
  iso: [2, 2, 3],
  side: [3, 0.75, 0.25],
} as const;

export interface PrimitiveCamera {
  readonly viewProjection: Mat4;
}

export function primitiveCamera(angle: PrimitiveCameraAngle): PrimitiveCamera {
  const node = group({ position: POSITIONS[angle] }).lookAt([0, 0, 0]);
  const projection = perspective({ fov: 45, near: 0.1, far: 100 }, 1, new Float32Array(16));
  const matrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
  viewMatrices(
    { position: new Float32Array(node.worldPosition), quaternion: new Float32Array(node.quaternion) },
    projection,
    matrices,
  );
  return { viewProjection: matrices.viewProjection };
}
