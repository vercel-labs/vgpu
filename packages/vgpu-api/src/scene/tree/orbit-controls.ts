import { sceneValueError } from "./errors.ts";
import { invertAffineMat4, transformPoint } from "./math.ts";
import type { SceneNode, Vec3Like } from "./node.ts";

interface OrbitPointerEvent {
  readonly pointerId: number;
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface OrbitWheelEvent {
  readonly deltaY: number;
  preventDefault(): void;
}

/**
 * Structural event-target contract so controls work with an `HTMLCanvasElement` without
 * requiring DOM types, and with mocks in Node tests. Listener parameters are intentionally
 * loose (`any`) so the DOM's overloaded `addEventListener` stays assignable.
 */
export interface OrbitControlsElement {
  // `any` keeps the DOM's overloaded addEventListener assignable to this contract.
  addEventListener(type: string, listener: (event: any) => void, options?: { passive?: boolean } | boolean): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

export interface OrbitControlsOptions {
  /** Pointer/wheel event source (usually the canvas). Omit for programmatic-only control. */
  readonly element?: OrbitControlsElement;
  /** World-space point the camera orbits and looks at. Defaults to `[0, 0, 0]`. */
  readonly target?: Vec3Like;
  /** Easing time constant in seconds (~63% convergence). `0` applies input immediately. */
  readonly damping?: number;
  /** Drag sensitivity in radians per pixel. */
  readonly rotateSpeed?: number;
  /** Wheel zoom sensitivity multiplier. */
  readonly zoomSpeed?: number;
  readonly distance?: { readonly min?: number; readonly max?: number };
  /** Pitch limits in radians. Defaults keep the camera off the poles. */
  readonly pitch?: { readonly min?: number; readonly max?: number };
  readonly label?: string;
}

export interface OrbitControlsValues {
  readonly yaw?: number;
  readonly pitch?: number;
  readonly distance?: number;
  readonly target?: Vec3Like;
}

const MAX_PITCH_DEFAULT = Math.PI / 2 - 0.01;
const EPSILON = 1e-6;
const DEFAULT_DELTA_TIME = 1 / 60;
const TMP_PARENT_INVERSE = new Float32Array(16);

/**
 * Shared drag-orbit + wheel-zoom controls around a target point. Input adjusts goal values;
 * `update(deltaTime)` eases the current state toward them and writes the node's transform,
 * so it composes with `frame.loop` and on-demand rendering alike.
 */
export class OrbitControls {
  readonly label: string | undefined;

  #node: SceneNode;
  #element: OrbitControlsElement | undefined;
  #target = new Float32Array(3);
  #localTarget = new Float32Array(3);
  #yaw = 0;
  #pitch = 0;
  #distance = 1;
  #goalYaw = 0;
  #goalPitch = 0;
  #goalDistance = 1;
  #damping: number;
  #rotateSpeed: number;
  #zoomSpeed: number;
  #minDistance: number;
  #maxDistance: number;
  #minPitch: number;
  #maxPitch: number;
  #dragging = false;
  #lastX = 0;
  #lastY = 0;
  #applied = false;
  #disposed = false;

  #onPointerDown = (event: OrbitPointerEvent): void => {
    if (event.button !== 0) return;
    this.#dragging = true;
    this.#lastX = event.clientX;
    this.#lastY = event.clientY;
    this.#element?.setPointerCapture?.(event.pointerId);
  };

  #onPointerMove = (event: OrbitPointerEvent): void => {
    if (!this.#dragging) return;
    const dx = event.clientX - this.#lastX;
    const dy = event.clientY - this.#lastY;
    this.#lastX = event.clientX;
    this.#lastY = event.clientY;
    this.#goalYaw -= dx * this.#rotateSpeed;
    this.#goalPitch = clamp(this.#goalPitch + dy * this.#rotateSpeed, this.#minPitch, this.#maxPitch);
  };

  #onPointerUp = (event: OrbitPointerEvent): void => {
    this.#dragging = false;
    this.#element?.releasePointerCapture?.(event.pointerId);
  };

  #onWheel = (event: OrbitWheelEvent): void => {
    event.preventDefault();
    const factor = Math.exp(event.deltaY * 0.001 * this.#zoomSpeed);
    this.#goalDistance = clamp(this.#goalDistance * factor, this.#minDistance, this.#maxDistance);
  };

  constructor(node: SceneNode, options: OrbitControlsOptions = {}) {
    this.#node = node;
    this.label = options.label;
    this.#damping = options.damping ?? 0.1;
    this.#rotateSpeed = options.rotateSpeed ?? 0.005;
    this.#zoomSpeed = options.zoomSpeed ?? 1;
    this.#minDistance = options.distance?.min ?? EPSILON;
    this.#maxDistance = options.distance?.max ?? Infinity;
    this.#minPitch = options.pitch?.min ?? -MAX_PITCH_DEFAULT;
    this.#maxPitch = options.pitch?.max ?? MAX_PITCH_DEFAULT;
    if (options.target !== undefined) writeVec3(this.#target, options.target, "target", this.label ?? "orbitControls");

    // Derive the initial spherical pose from the node's current position. Both operands
    // live in the node's parent space, so the world target is pulled into it first.
    const target = this.#targetInNodeSpace();
    const ox = node.position[0]! - target[0]!;
    const oy = node.position[1]! - target[1]!;
    const oz = node.position[2]! - target[2]!;
    const length = Math.hypot(ox, oy, oz);
    this.#distance = clamp(length > 0 ? length : 1, this.#minDistance, this.#maxDistance);
    this.#yaw = length > 0 ? Math.atan2(ox, oz) : 0;
    this.#pitch = length > 0 ? clamp(Math.asin(oy / length), this.#minPitch, this.#maxPitch) : 0;
    this.#goalYaw = this.#yaw;
    this.#goalPitch = this.#pitch;
    this.#goalDistance = this.#distance;

    const element = options.element;
    if (element) {
      this.#element = element;
      element.addEventListener("pointerdown", this.#onPointerDown);
      element.addEventListener("pointermove", this.#onPointerMove);
      element.addEventListener("pointerup", this.#onPointerUp);
      element.addEventListener("pointercancel", this.#onPointerUp);
      element.addEventListener("wheel", this.#onWheel, { passive: false });
    }
  }

  /** Jumps yaw/pitch/distance/target immediately (both current state and goal). */
  set(values: OrbitControlsValues): this {
    const where = this.#where("set");
    // Validate everything up front: a NaN that reaches the state can never be eased out.
    if (values.yaw !== undefined) requireFinite(where, "yaw", values.yaw);
    if (values.pitch !== undefined) requireFinite(where, "pitch", values.pitch);
    if (values.distance !== undefined) requireFinite(where, "distance", values.distance);
    if (values.target !== undefined) writeVec3(this.#target, values.target, "target", where);
    if (values.yaw !== undefined) this.#yaw = this.#goalYaw = values.yaw;
    if (values.pitch !== undefined) this.#pitch = this.#goalPitch = clamp(values.pitch, this.#minPitch, this.#maxPitch);
    if (values.distance !== undefined) this.#distance = this.#goalDistance = clamp(values.distance, this.#minDistance, this.#maxDistance);
    this.#applied = false;
    return this;
  }

  /**
   * Eases toward the goal state and writes the node transform. Returns true when the node
   * moved — useful to skip re-rendering static frames.
   */
  update(deltaTime = DEFAULT_DELTA_TIME): boolean {
    // A non-finite dt (the classic first-frame `performance.now()` delta) would otherwise
    // write NaN into yaw/pitch/distance permanently: NaN < EPSILON is false, so the snap
    // rescue below never fires and the state can never recover.
    const dt = Number.isFinite(deltaTime) ? Math.max(deltaTime, 0) : DEFAULT_DELTA_TIME;
    const position = this.#node.position;
    const gap = Math.max(
      Math.abs(this.#goalYaw - this.#yaw),
      Math.abs(this.#goalPitch - this.#pitch),
      Math.abs(this.#goalDistance - this.#distance),
    );
    const settled = gap < EPSILON && this.#applied;
    if (!settled) {
      const t = this.#damping > 0 ? 1 - Math.exp(-dt / this.#damping) : 1;
      this.#yaw += (this.#goalYaw - this.#yaw) * t;
      this.#pitch += (this.#goalPitch - this.#pitch) * t;
      this.#distance += (this.#goalDistance - this.#distance) * t;
      if (gap < EPSILON) {
        this.#yaw = this.#goalYaw;
        this.#pitch = this.#goalPitch;
        this.#distance = this.#goalDistance;
      }
    }
    const cosPitch = Math.cos(this.#pitch);
    // `node.position` is parent-local, so the orbit is built around the target expressed in
    // that same space; `lookAt()` takes the world target (it does its own parent transform).
    const target = this.#targetInNodeSpace();
    const x = target[0]! + Math.sin(this.#yaw) * cosPitch * this.#distance;
    const y = target[1]! + Math.sin(this.#pitch) * this.#distance;
    const z = target[2]! + Math.cos(this.#yaw) * cosPitch * this.#distance;
    // A settled state still has to be re-applied when the rig above the node moved, which
    // changes where the world target sits in parent space. `position` holds exactly what a
    // previous write rounded to, so `fround` compares without a tolerance.
    if (settled && Math.fround(x) === position[0]! && Math.fround(y) === position[1]! && Math.fround(z) === position[2]!) {
      return false;
    }
    this.#node.set({ position: [x, y, z] });
    this.#node.lookAt(this.#target);
    this.#applied = true;
    return true;
  }

  get yaw(): number {
    return this.#yaw;
  }

  get pitch(): number {
    return this.#pitch;
  }

  get distance(): number {
    return this.#distance;
  }

  /** Orbit target. Stable array identity; mutate via `set()`. */
  get target(): Float32Array {
    return this.#target;
  }

  /** Removes event listeners. The node keeps its last transform. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const element = this.#element;
    if (element) {
      element.removeEventListener("pointerdown", this.#onPointerDown);
      element.removeEventListener("pointermove", this.#onPointerMove);
      element.removeEventListener("pointerup", this.#onPointerUp);
      element.removeEventListener("pointercancel", this.#onPointerUp);
      element.removeEventListener("wheel", this.#onWheel);
    }
    this.#element = undefined;
  }

  #where(method: string): string {
    return `${this.label ?? "orbitControls"}.${method}`;
  }

  /**
   * The world-space target expressed in the node's parent space, which is the space
   * `node.position` lives in. Recomputed per call because the rig above the node may move
   * between frames. Returns the world target unchanged for unparented nodes.
   */
  #targetInNodeSpace(): Float32Array {
    const parent = this.#node.parent;
    if (!parent) return this.#target;
    invertAffineMat4(TMP_PARENT_INVERSE, parent.worldMatrix);
    return transformPoint(this.#localTarget, TMP_PARENT_INVERSE, this.#target);
  }
}

/** Creates drag-orbit + wheel-zoom controls that drive a camera (or any node). */
export function orbitControls(node: SceneNode, options: OrbitControlsOptions = {}): OrbitControls {
  return new OrbitControls(node, options);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function requireFinite(where: string, name: string, value: number): void {
  if (!Number.isFinite(value)) throw sceneValueError(where, name, "a finite number");
}

function writeVec3(out: Float32Array, value: Vec3Like, name: string, where: string): void {
  if (value.length !== 3) throw sceneValueError(where, name, "an array of 3 numbers");
  for (let i = 0; i < 3; i++) {
    if (!Number.isFinite(value[i]!)) throw sceneValueError(where, name, "an array of 3 finite numbers");
  }
  out[0] = value[0]!;
  out[1] = value[1]!;
  out[2] = value[2]!;
}
