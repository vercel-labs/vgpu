import { sceneCycleError, sceneValueError } from "./errors.ts";
import {
  composeTrs,
  copyMat4,
  identityMat4,
  invertAffineMat4,
  multiplyMat4,
  quatFromEuler,
  quatLookAt,
  transformDirection,
  transformPoint,
  type Mat4,
} from "./math.ts";

/** Three-component vector input accepted by scene-tree setters. */
export type Vec3Like = readonly [number, number, number] | readonly number[] | Float32Array;

/** Quaternion input (x, y, z, w) accepted by scene-tree setters. */
export type QuatLike = readonly [number, number, number, number] | readonly number[] | Float32Array;

export type SceneNodeKind =
  | "scene"
  | "group"
  | "mesh"
  | "perspective-camera"
  | "orthographic-camera"
  | "directional-light"
  | "ambient-light";

/** Transform and flag values accepted by `node.set()`. */
export interface NodeTransformValues {
  readonly position?: Vec3Like;
  /** Intrinsic XYZ Euler angles in radians. Ignored when `quaternion` is also given. */
  readonly rotation?: Vec3Like;
  readonly quaternion?: QuatLike;
  readonly scale?: number | Vec3Like;
  readonly visible?: boolean;
  readonly label?: string;
}

/** Options accepted by node factories (`group()`, `mesh()`, `scene()`, cameras, lights). */
export interface NodeOptions extends NodeTransformValues {
  readonly children?: readonly SceneNode[];
}

const UP: Float32Array = new Float32Array([0, 1, 0]);
const TMP_EYE = new Float32Array(3);
const TMP_TARGET = new Float32Array(3);
const TMP_UP = new Float32Array(3);
const TMP_PARENT_INVERSE = new Float32Array(16);

/**
 * Base scene-tree node: a TRS transform with parent/children links. Mutation goes through
 * `set()` so world matrices are recomputed lazily and only for dirty subtrees; the exposed
 * arrays keep a stable identity and are updated in place.
 */
export class SceneNode {
  readonly kind: SceneNodeKind;
  label: string | undefined;
  visible = true;

  #position = new Float32Array(3);
  #quaternion = new Float32Array([0, 0, 0, 1]);
  #scale = new Float32Array([1, 1, 1]);
  #localMatrix = identityMat4(new Float32Array(16));
  #worldMatrix = identityMat4(new Float32Array(16));
  #worldPosition = new Float32Array(3);
  #localDirty = false;
  #worldDirty = false;
  #parent: SceneNode | null = null;
  #children: SceneNode[] = [];
  protected _worldVersion = 0;

  constructor(kind: SceneNodeKind, options: NodeOptions = {}) {
    this.kind = kind;
    this.label = options.label;
    // Non-virtual application: subclass `set()` overrides touch subclass fields that are
    // not installed yet while the base constructor runs.
    this.#applyTransform(options);
    if (options.children) this.add(...options.children);
  }

  /** Updates transform components in place; unspecified components are left untouched. */
  set(values: NodeTransformValues): this {
    this.#applyTransform(values);
    return this;
  }

  #applyTransform(values: NodeTransformValues): void {
    const where = `${this.label ?? this.kind}.set`;
    let transformTouched = false;
    if (values.position !== undefined) {
      writeVec3(this.#position, values.position, "position", where);
      transformTouched = true;
    }
    if (values.quaternion !== undefined) {
      if (values.quaternion.length !== 4) throw sceneValueError(where, "quaternion", "an array of 4 numbers (x, y, z, w)");
      this.#quaternion[0] = values.quaternion[0]!;
      this.#quaternion[1] = values.quaternion[1]!;
      this.#quaternion[2] = values.quaternion[2]!;
      this.#quaternion[3] = values.quaternion[3]!;
      transformTouched = true;
    } else if (values.rotation !== undefined) {
      if (values.rotation.length !== 3) throw sceneValueError(where, "rotation", "an array of 3 Euler angles in radians");
      quatFromEuler(this.#quaternion, values.rotation[0]!, values.rotation[1]!, values.rotation[2]!);
      transformTouched = true;
    }
    if (values.scale !== undefined) {
      if (typeof values.scale === "number") {
        this.#scale.fill(values.scale);
      } else {
        writeVec3(this.#scale, values.scale, "scale", where);
      }
      transformTouched = true;
    }
    if (values.visible !== undefined) this.visible = values.visible;
    if (values.label !== undefined) this.label = values.label;
    if (transformTouched) this.#markTransformDirty();
  }

  /**
   * Rotates the node so its -Z axis points at a world-space target.
   *
   * The whole computation runs in parent space (the target and up hint are pulled through
   * the parent's affine inverse), which stays exact under non-uniform parent scale: an
   * affine map sends the parent-space ray through the target to the world-space ray through
   * the world target. Extracting a scale-stripped parent rotation instead — as an earlier
   * version did — skews the forward vector whenever the parent scale is anisotropic.
   */
  lookAt(target: Vec3Like, up: Vec3Like = UP): this {
    const where = `${this.label ?? this.kind}.lookAt`;
    writeVec3(TMP_TARGET, target, "target", where);
    writeVec3(TMP_UP, up, "up", where);
    TMP_EYE.set(this.#position);
    const parent = this.#parent;
    if (parent) {
      invertAffineMat4(TMP_PARENT_INVERSE, parent.worldMatrix);
      transformPoint(TMP_TARGET, TMP_PARENT_INVERSE, TMP_TARGET);
      transformDirection(TMP_UP, TMP_PARENT_INVERSE, TMP_UP);
    }
    quatLookAt(this.#quaternion, TMP_EYE, TMP_TARGET, TMP_UP);
    this.#markTransformDirty();
    return this;
  }

  /** Adds children, reparenting them if needed. Throws `VGPU-SCENE-CYCLE` on cycles. */
  add(...nodes: SceneNode[]): this {
    const where = `${this.label ?? this.kind}.add`;
    for (const node of nodes) {
      for (let ancestor: SceneNode | null = this; ancestor; ancestor = ancestor.#parent) {
        if (ancestor === node) throw sceneCycleError(where, node.label ?? node.kind);
      }
      if (node.#parent) node.#parent.#removeChild(node);
      node.#parent = this;
      this.#children.push(node);
      node.#markWorldDirty();
    }
    return this;
  }

  /** Removes direct children; nodes that are not children are ignored. */
  remove(...nodes: SceneNode[]): this {
    for (const node of nodes) {
      if (node.#parent === this) this.#removeChild(node);
    }
    return this;
  }

  /** Detaches this node from its parent, keeping its local transform. */
  removeFromParent(): this {
    if (this.#parent) this.#parent.#removeChild(this);
    return this;
  }

  /** Depth-first visit of this node and all descendants. */
  traverse(visit: (node: SceneNode) => void): void {
    visit(this);
    for (const child of this.#children) child.traverse(visit);
  }

  get parent(): SceneNode | null {
    return this.#parent;
  }

  get children(): readonly SceneNode[] {
    return this.#children;
  }

  /** Local position. Stable array identity; mutate via `set()`. */
  get position(): Float32Array {
    return this.#position;
  }

  /** Local rotation quaternion (x, y, z, w). Stable array identity; mutate via `set()`. */
  get quaternion(): Float32Array {
    return this.#quaternion;
  }

  /** Local scale. Stable array identity; mutate via `set()`. */
  get scale(): Float32Array {
    return this.#scale;
  }

  /** Column-major local TRS matrix, recomputed lazily. Stable array identity. */
  get localMatrix(): Mat4 {
    if (this.#localDirty) {
      composeTrs(this.#localMatrix, this.#position, this.#quaternion, this.#scale);
      this.#localDirty = false;
    }
    return this.#localMatrix;
  }

  /** Column-major world matrix, recomputed lazily for dirty subtrees. Stable array identity. */
  get worldMatrix(): Mat4 {
    if (this.#worldDirty || this.#localDirty) {
      const local = this.localMatrix;
      const parent = this.#parent;
      if (parent) {
        multiplyMat4(this.#worldMatrix, parent.worldMatrix, local);
      } else {
        copyMat4(this.#worldMatrix, local);
      }
      this.#worldDirty = false;
      this._worldVersion++;
    }
    return this.#worldMatrix;
  }

  /** World-space position derived from `worldMatrix`. Stable array identity. */
  get worldPosition(): Float32Array {
    const world = this.worldMatrix;
    this.#worldPosition[0] = world[12]!;
    this.#worldPosition[1] = world[13]!;
    this.#worldPosition[2] = world[14]!;
    return this.#worldPosition;
  }

  #markTransformDirty(): void {
    this.#localDirty = true;
    this.#markWorldDirty(true);
  }

  #markWorldDirty(force = false): void {
    if (this.#worldDirty && !force) return;
    this.#worldDirty = true;
    for (const child of this.#children) child.#markWorldDirty();
  }

  #removeChild(node: SceneNode): void {
    const index = this.#children.indexOf(node);
    if (index >= 0) this.#children.splice(index, 1);
    node.#parent = null;
    node.#markWorldDirty(true);
  }
}

/** Creates a plain transform node used to group children. */
export function group(options: NodeOptions = {}): SceneNode {
  return new SceneNode("group", options);
}

function writeVec3(out: Float32Array, value: Vec3Like, name: string, where: string): void {
  if (value.length !== 3) throw sceneValueError(where, name, "an array of 3 numbers");
  out[0] = value[0]!;
  out[1] = value[1]!;
  out[2] = value[2]!;
}
