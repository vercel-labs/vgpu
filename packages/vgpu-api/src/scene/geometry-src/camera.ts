import type { Mat4, Vec3 } from "wgpu-matrix";

/** A pure camera value containing the matrix shaders need for drawing. */
export interface Camera {
  /** Column-major projection times view matrix, computed once at construction. */
  readonly viewProjectionMatrix: Mat4;
  /** Camera position in world space. */
  readonly position: Vec3;
}

export type { Mat4, Vec3 };
