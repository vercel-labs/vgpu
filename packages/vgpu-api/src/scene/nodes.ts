import { VGPUError } from "../errors.ts";
import {
  composeMatrix,
  invertAffine,
  multiplyMatrices,
  type Mat4,
  type QuatLike,
  type TransformValues,
  type Vec3Like,
} from "./transforms.ts";
import { isFiniteFloat32, readFiniteValues, valueError } from "./validation.ts";

export type { Mat4, QuatLike, Vec3Like } from "./transforms.ts";

export type SceneNodeKind = "group";

export interface NodeTransformValues extends TransformValues {
  readonly visible?: boolean;
  readonly label?: string;
}

export interface NodeOptions extends NodeTransformValues {
  readonly children?: readonly SceneNode[];
}

const DEFAULT_UP = new Float32Array([0, 1, 0]);

export class SceneNode {
  readonly kind: SceneNodeKind;
  label: string | undefined;
  visible = true;

  #position = new Float32Array(3);
  #quaternion = new Float32Array([0, 0, 0, 1]);
  #scale = new Float32Array([1, 1, 1]);
  #localMatrix = identityMatrix();
  #worldMatrix = identityMatrix();
  #worldPosition = new Float32Array(3);
  #localDirty = false;
  #worldDirty = false;
  #parent: SceneNode | null = null;
  #children: SceneNode[] = [];

  constructor(kind: SceneNodeKind, options: NodeOptions = {}) {
    this.kind = kind;
    this.label = undefined;
    this.#applyTransform(options);
    if (options.children !== undefined) {
      for (let index = 0; index < options.children.length; index++) {
        if (!(options.children[index] instanceof SceneNode)) {
          throw valueError(
            "VGPU-SCENE-VALUE",
            "SceneNode",
            `children[${index}]`,
            "the value is not a SceneNode",
            "Pass only SceneNode values in children.",
          );
        }
      }
      this.add(...options.children);
    }
  }

  set(values: NodeTransformValues): this {
    this.#applyTransform(values);
    return this;
  }

  lookAt(target: Vec3Like, up: Vec3Like = DEFAULT_UP): this {
    const where = `${this.label ?? this.kind}.lookAt`;
    const localTarget = Array.from(new Float32Array(readNodeVector(target, where, "target")));
    const localUp = Array.from(new Float32Array(readNodeVector(up, where, "up")));
    const worldEye = this.worldPosition;
    const coincident = localTarget[0] === worldEye[0] && localTarget[1] === worldEye[1] && localTarget[2] === worldEye[2];
    const eye = Array.from(this.#position);
    if (this.#parent !== null) {
      const inverse = new Float32Array(16);
      try {
        invertAffine(this.#parent.worldMatrix, inverse);
      } catch (error) {
        if ((error as { code?: string }).code !== "VGPU-SPATIAL-SINGULAR") throw error;
        throw new VGPUError({
          code: "VGPU-SPATIAL-SINGULAR",
          message: `${where} cannot compensate a parent with a singular or non-representable world inverse.`,
          fix: "Restore an invertible finite affine parent with representable scales before calling lookAt(); the quaternion was left unchanged.",
          where,
          cause: error,
        });
      }
      if (coincident) {
        this.#quaternion.set([0, 0, 0, 1]);
        this.#markTransformDirty();
        return this;
      }
      transformPoint(localTarget, inverse, localTarget);
      transformDirection(localUp, inverse, localUp);
    } else if (coincident) {
      this.#quaternion.set([0, 0, 0, 1]);
      this.#markTransformDirty();
      return this;
    }

    const quaternion = lookAtQuaternion(eye, localTarget, localUp);
    const candidateMatrix = new Float32Array(16);
    composeMatrix({ position: this.#position, quaternion, scale: this.#scale }, candidateMatrix);
    this.#quaternion.set(quaternion);
    this.#markTransformDirty();
    return this;
  }

  add(...nodes: SceneNode[]): this {
    const where = `${this.label ?? this.kind}.add`;
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]!;
      if (!(node instanceof SceneNode)) {
        throw valueError(
          "VGPU-SCENE-VALUE",
          where,
          `nodes[${index}]`,
          "the value is not a SceneNode",
          "Pass only SceneNode values to add().",
        );
      }
      for (let ancestor: SceneNode | null = this; ancestor !== null; ancestor = ancestor.#parent) {
        if (ancestor === node) throw sceneCycleError(where, node.label ?? node.kind);
      }
    }
    for (const node of nodes) {
      if (node.#parent !== null) node.#parent.#removeChild(node);
      node.#parent = this;
      this.#children.push(node);
      node.#markWorldDirty();
    }
    return this;
  }

  remove(...nodes: SceneNode[]): this {
    for (const node of nodes) {
      if (node.#parent === this) this.#removeChild(node);
    }
    return this;
  }

  removeFromParent(): this {
    if (this.#parent !== null) this.#parent.#removeChild(this);
    return this;
  }

  traverse(visit: (node: SceneNode) => void): void {
    const stack: SceneNode[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      visit(node);
      for (let index = node.#children.length - 1; index >= 0; index--) stack.push(node.#children[index]!);
    }
  }

  get parent(): SceneNode | null {
    return this.#parent;
  }

  get children(): readonly SceneNode[] {
    return this.#children;
  }

  get position(): Float32Array {
    return this.#position;
  }

  get quaternion(): Float32Array {
    return this.#quaternion;
  }

  get scale(): Float32Array {
    return this.#scale;
  }

  get localMatrix(): Mat4 {
    if (this.#localDirty) {
      composeMatrix({ position: this.#position, quaternion: this.#quaternion, scale: this.#scale }, this.#localMatrix);
      this.#localDirty = false;
    }
    return this.#localMatrix;
  }

  get worldMatrix(): Mat4 {
    const lineage: SceneNode[] = [];
    for (let node: SceneNode | null = this; node !== null; node = node.#parent) lineage.push(node);
    for (let index = lineage.length - 1; index >= 0; index--) {
      const node = lineage[index]!;
      if (!node.#worldDirty && !node.#localDirty) continue;
      const local = node.localMatrix;
      if (node.#parent === null) node.#worldMatrix.set(local);
      else multiplyMatrices(node.#parent.#worldMatrix, local, node.#worldMatrix);
      node.#worldDirty = false;
    }
    return this.#worldMatrix;
  }

  get worldPosition(): Float32Array {
    const world = this.worldMatrix;
    this.#worldPosition[0] = world[12]!;
    this.#worldPosition[1] = world[13]!;
    this.#worldPosition[2] = world[14]!;
    return this.#worldPosition;
  }

  #applyTransform(values: NodeTransformValues): void {
    const operation = `${this.label ?? this.kind}.set`;
    const position = values.position === undefined
      ? Array.from(this.#position)
      : readNodeVector(values.position, operation, "position");

    let quaternion = Array.from(this.#quaternion);
    if (values.quaternion !== undefined) {
      quaternion = normalizedQuaternion(values.quaternion, operation);
    } else if (values.rotation !== undefined) {
      const rotation = readNodeVector(values.rotation, operation, "rotation", false);
      quaternion = quaternionFromEuler(rotation[0]!, rotation[1]!, rotation[2]!);
    }

    let scale = Array.from(this.#scale);
    if (values.scale !== undefined) {
      if (typeof values.scale === "number") {
        assertNodeFloat(values.scale, operation, "scale");
        scale = [values.scale, values.scale, values.scale];
      } else {
        scale = readNodeVector(values.scale, operation, "scale");
      }
    }

    const visible = values.visible === undefined ? this.visible : values.visible;
    if (typeof visible !== "boolean") {
      throw valueError("VGPU-SCENE-VALUE", operation, "visible", "the value is not a boolean", "Pass true or false for visible.");
    }
    const label = values.label === undefined ? this.label : values.label;
    if (label !== undefined && typeof label !== "string") {
      throw valueError("VGPU-SCENE-VALUE", operation, "label", "the value is not a string", "Pass a string for label.");
    }

    const storedPosition = new Float32Array(position);
    const storedQuaternion = new Float32Array(quaternion);
    const storedScale = new Float32Array(scale);
    const candidateMatrix = new Float32Array(16);
    composeMatrix({ position: storedPosition, quaternion: storedQuaternion, scale: storedScale }, candidateMatrix);
    const transformTouched = values.position !== undefined
      || values.rotation !== undefined
      || values.quaternion !== undefined
      || values.scale !== undefined;
    if (transformTouched) {
      this.#position.set(storedPosition);
      this.#quaternion.set(storedQuaternion);
      this.#scale.set(storedScale);
    }
    this.visible = visible;
    this.label = label;
    if (transformTouched) this.#markTransformDirty();
  }

  #markTransformDirty(): void {
    this.#localDirty = true;
    this.#markWorldDirty();
  }

  #markWorldDirty(): void {
    const stack: SceneNode[] = [this];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.#worldDirty) continue;
      node.#worldDirty = true;
      for (const child of node.#children) stack.push(child);
    }
  }

  #removeChild(node: SceneNode): void {
    const index = this.#children.indexOf(node);
    if (index >= 0) this.#children.splice(index, 1);
    node.#parent = null;
    node.#markWorldDirty();
  }
}

export function group(options: NodeOptions = {}): SceneNode {
  return new SceneNode("group", options);
}

function identityMatrix(): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function readNodeVector(value: ArrayLike<number>, operation: string, field: string, requireFloat32 = true): number[] {
  const result = readFiniteValues(value, 3, operation, field, "VGPU-SCENE-VALUE");
  if (requireFloat32) {
    for (let index = 0; index < 3; index++) assertNodeFloat(result[index]!, operation, `${field}[${index}]`);
  }
  return result;
}

function assertNodeFloat(value: number, operation: string, field: string): void {
  if (!isFiniteFloat32(value)) {
    throw valueError(
      "VGPU-SCENE-VALUE",
      operation,
      field,
      `${String(value)} is not representable as finite float32`,
      `Pass a finite float32-representable value for ${field}.`,
    );
  }
}

function normalizedQuaternion(value: QuatLike, operation: string): number[] {
  const input = readFiniteValues(value, 4, operation, "quaternion", "VGPU-SCENE-VALUE");
  const length = Math.hypot(input[0]!, input[1]!, input[2]!, input[3]!);
  if (length === 0 || !Number.isFinite(length)) {
    throw valueError(
      "VGPU-SCENE-VALUE",
      operation,
      "quaternion",
      "the quaternion has zero or non-finite length",
      "Pass a finite, nonzero XYZW quaternion.",
    );
  }
  const result = input.map((component) => component / length);
  for (let index = 0; index < 4; index++) assertNodeFloat(result[index]!, operation, `quaternion[${index}]`);
  return result;
}

function quaternionFromEuler(x: number, y: number, z: number): number[] {
  const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function lookAtQuaternion(eye: readonly number[], target: readonly number[], up: readonly number[]): number[] {
  let zx = eye[0]! - target[0]!, zy = eye[1]! - target[1]!, zz = eye[2]! - target[2]!;
  const zLength = Math.hypot(zx, zy, zz);
  if (zLength === 0) return [0, 0, 0, 1];
  zx /= zLength; zy /= zLength; zz /= zLength;

  let xx = up[1]! * zz - up[2]! * zy;
  let xy = up[2]! * zx - up[0]! * zz;
  let xz = up[0]! * zy - up[1]! * zx;
  let xLength = Math.hypot(xx, xy, xz);
  if (xLength === 0) {
    xx = zz; xy = 0; xz = -zx;
    xLength = Math.hypot(xx, xy, xz);
    if (xLength === 0) { xx = 1; xy = 0; xz = 0; xLength = 1; }
  }
  xx /= xLength; xy /= xLength; xz /= xLength;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return quaternionFromBasis(xx, xy, xz, yx, yy, yz, zx, zy, zz);
}

function quaternionFromBasis(
  m00: number, m01: number, m02: number,
  m10: number, m11: number, m12: number,
  m20: number, m21: number, m22: number,
): number[] {
  let result: number[];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    result = [(m12 - m21) * s, (m20 - m02) * s, (m01 - m10) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    result = [0.25 * s, (m10 + m01) / s, (m20 + m02) / s, (m12 - m21) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    result = [(m10 + m01) / s, 0.25 * s, (m21 + m12) / s, (m20 - m02) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    result = [(m20 + m02) / s, (m21 + m12) / s, 0.25 * s, (m01 - m10) / s];
  }
  const length = Math.hypot(result[0]!, result[1]!, result[2]!, result[3]!);
  return result.map((component) => component / length);
}

function transformPoint(out: number[], matrix: ArrayLike<number>, point: readonly number[]): void {
  const x = point[0]!, y = point[1]!, z = point[2]!;
  out[0] = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!;
  out[1] = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!;
  out[2] = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!;
}

function transformDirection(out: number[], matrix: ArrayLike<number>, direction: readonly number[]): void {
  const x = direction[0]!, y = direction[1]!, z = direction[2]!;
  out[0] = matrix[0]! * x + matrix[4]! * y + matrix[8]! * z;
  out[1] = matrix[1]! * x + matrix[5]! * y + matrix[9]! * z;
  out[2] = matrix[2]! * x + matrix[6]! * y + matrix[10]! * z;
}

function sceneCycleError(where: string, label: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SCENE-CYCLE",
    message: `add() would make '${label}' an ancestor of itself.`,
    fix: "Remove the ancestor link first, or attach a different node.",
    where,
  });
}
