// Pointer, touch and keyboard input on the canvas. DOM events in, plain state out: the renderer
// copies `cursor` into the colony brush each frame and moves the camera through the orbit rig.

import { dolly, orbit, type OrbitRig } from "vgpu/scene";

import { clampToTile } from "./terrain";

export type Tool = "orbit" | "elevate" | "lower" | "destination";
export const TOOLS: readonly Tool[] = ["orbit", "elevate", "lower", "destination"];

/** Every tool but orbit edits the ground; the camera then moves only by wheel or pinch zoom. */
export function isEditTool(tool: Tool): boolean {
  return tool !== "orbit";
}

export const ORBIT_LIMITS = { minPitch: 0.16, maxPitch: 1.42, minDistance: 1.6, maxDistance: 30 } as const;

const PAN_LIMIT = 7;
/** Keyboard cursor step in world units (Shift moves faster). */
export const CURSOR_STEP = 0.15;

/** Where the brush or destination aim sits, and whether it is pressed. */
export interface Cursor {
  x: number;
  z: number;
  /** Shown on the terrain (a mouse hovers it, a finger presses it, or the keyboard drives it). */
  visible: boolean;
  /** Sculpting now (pointer held or Enter/Space held). */
  pressed: boolean;
}

export interface GardenInputOptions {
  tool(): Tool;
  /** Terrain point under a client position; false when the ray misses the tile. */
  pick(clientX: number, clientY: number, out: [number, number]): boolean;
  onDestination(x: number, z: number): void;
  onTool(tool: Tool): void;
  onPause(): void;
  onStep(): void;
}

export interface GardenInput {
  readonly cursor: Cursor;
  /** A pointer hovers or presses the canvas, or a key is held (idle orbit pauses). */
  readonly engaged: boolean;
  /** The keyboard drives the cursor (the canvas has focus in a tool mode). */
  readonly keyboard: boolean;
  /**
   * Drop every press: pointers, two-finger gestures and a held Enter/Space. The renderer calls it
   * when the tool changes or the window loses focus, so no gesture outlives the tool it began in.
   */
  cancel(): void;
  dispose(): void;
}

export interface InputElement {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  hasPointerCapture?(pointerId: number): boolean;
}

interface TrackedPointer {
  x: number;
  y: number;
  readonly type: string;
  /**
   * What this press does: orbit or pan the camera (orbit tool only), sculpt or aim a destination
   * (edit tools), or nothing (the finger left over after a two-finger gesture).
   */
  action: "orbit" | "pan" | "sculpt" | "aim" | "none";
  /** A sculpt or aim press is over the tile (a miss stays pending until the pointer reaches it). */
  onTile: boolean;
}

/** Ground-plane pan along the camera's horizontal axes, bounded to the tile. */
export function panGround(goal: OrbitRig, right: number, forward: number): void {
  const sin = Math.sin(goal.yaw);
  const cos = Math.cos(goal.yaw);
  goal.pan[0] = clamp(goal.pan[0]! + right * cos - forward * sin, -PAN_LIMIT, PAN_LIMIT);
  goal.pan[2] = clamp(goal.pan[2]! - right * sin - forward * cos, -PAN_LIMIT, PAN_LIMIT);
}

/**
 * The tools are exclusive. Orbit: drag orbits, right/Shift-drag pans, two fingers orbit and pinch.
 * Elevate/lower: a press sculpts wherever it is over the terrain, and only sculpts — a press that
 * misses the tile waits until it reaches it, and modifiers or the right button never move the
 * camera. Destination: press and drag to aim, release to send the robots. The wheel zooms in every
 * tool; in edit tools two fingers only pinch. Keys on the focused canvas: 1–4 pick the tool, arrows
 * move the cursor (orbit in the orbit tool), Enter/Space sculpt while held or set the destination,
 * +/- zoom, P pauses and . steps once. Pointercancel, lost capture and blur end a press.
 */
export function installInput(element: InputElement, goal: OrbitRig, options: GardenInputOptions): GardenInput {
  let disposed = false;
  let hovering = false;
  let focused = false;
  /**
   * Whether the canvas is being driven from the keyboard: set by keys and keyboard focus, cleared
   * by any pointer press. A tap focuses the canvas too, and must not leave the keyboard cursor up.
   */
  let keyboardDriven = false;
  /** A press came before the next focus event: that focus is the press's, not the keyboard's. */
  let pressFocus = false;
  /** Enter and Space while they are held to sculpt: the press lasts until both are up. */
  const heldKeys = new Set<string>();
  const cursor: Cursor = { x: 0, z: 0, visible: false, pressed: false };
  const pointers = new Map<number, TrackedPointer>();
  const hit: [number, number] = [0, 0];
  let pinchDistance = 0;
  let pinchX = 0;
  let pinchY = 0;
  let pointerCursor = false;

  const release = (pointerId: number) => {
    if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture?.(pointerId);
  };
  const keyboardCursor = () => focused && keyboardDriven && isEditTool(options.tool());

  const aimAt = (clientX: number, clientY: number): boolean => {
    if (!options.pick(clientX, clientY, hit)) return false;
    cursor.x = hit[0];
    cursor.z = hit[1];
    return true;
  };
  const refreshVisibility = () => {
    cursor.visible = isEditTool(options.tool()) && (pointerCursor || keyboardCursor());
  };
  /** Sculpting continues while a sculpt press is over the tile or Enter/Space is held. */
  const refreshPressed = () => {
    let pressing = heldKeys.size > 0;
    for (const pointer of pointers.values()) pressing ||= pointer.action === "sculpt" && pointer.onTile;
    cursor.pressed = pressing;
  };

  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
  };

  const pointerDown: EventListener = (event) => {
    const value = event as PointerEvent;
    const tool = options.tool();
    const edit = isEditTool(tool);
    // Any press, even one ignored below, hands the cursor to the pointer, and the focus it causes
    // next is not keyboard focus.
    keyboardDriven = false;
    pressFocus = true;
    // The right button pans in the orbit tool and does nothing in an edit tool.
    if (value.pointerType === "mouse" && value.button !== 0 && (edit || value.button !== 2)) {
      refreshVisibility();
      return;
    }
    if (pointers.size >= 2) return;
    let action: TrackedPointer["action"];
    let onTile = false;
    if (pointers.size === 1) {
      // A second finger turns the press into a two-finger gesture: it stops sculpting and aiming,
      // and the finger left after it lifts does nothing until every finger is up.
      action = "none";
      for (const pointer of pointers.values()) pointer.action = "none";
    } else if (!edit) {
      action = value.button === 2 || value.shiftKey ? "pan" : "orbit";
    } else {
      action = tool === "destination" ? "aim" : "sculpt";
      onTile = aimAt(value.clientX, value.clientY);
      pointerCursor = onTile;
    }
    pointers.set(value.pointerId, { x: value.clientX, y: value.clientY, type: value.pointerType, action, onTile });
    try {
      element.setPointerCapture?.(value.pointerId);
    } catch {
      // The pointer already ended (or was synthesised): track it uncaptured; its up still ends it.
    }
    if (pointers.size === 2) ({ distance: pinchDistance, x: pinchX, y: pinchY } = pinchState());
    refreshPressed();
    refreshVisibility();
  };

  const pointerMove: EventListener = (event) => {
    const value = event as PointerEvent;
    const pointer = pointers.get(value.pointerId);
    if (!pointer) {
      // Mouse hover shows the brush where it would land.
      if (value.pointerType === "mouse" && pointers.size === 0 && isEditTool(options.tool())) {
        pointerCursor = aimAt(value.clientX, value.clientY);
        refreshVisibility();
      }
      return;
    }
    const deltaX = value.clientX - pointer.x;
    const deltaY = value.clientY - pointer.y;
    pointer.x = value.clientX;
    pointer.y = value.clientY;
    if (pointers.size >= 2) {
      const next = pinchState();
      if (pinchDistance > 0 && next.distance > 0) dolly(goal, pinchDistance / next.distance, ORBIT_LIMITS);
      if (!isEditTool(options.tool())) orbit(goal, -(next.x - pinchX) * 0.005, (next.y - pinchY) * 0.004, ORBIT_LIMITS);
      ({ distance: pinchDistance, x: pinchX, y: pinchY } = next);
      return;
    }
    if (pointer.action === "sculpt" || pointer.action === "aim") {
      // Off the tile the brush holds its last spot and stops; it never sculpts the sky.
      pointer.onTile = aimAt(value.clientX, value.clientY);
      pointerCursor ||= pointer.onTile;
      refreshPressed();
      refreshVisibility();
      return;
    }
    if (pointer.action === "pan") panGround(goal, -deltaX * goal.distance * 0.0016, deltaY * goal.distance * 0.0016);
    else if (pointer.action === "orbit") orbit(goal, -deltaX * 0.005, deltaY * 0.004, ORBIT_LIMITS);
  };

  const pointerUp: EventListener = (event) => {
    const value = event as PointerEvent;
    const pointer = pointers.get(value.pointerId);
    if (!pointer) return;
    pointers.delete(value.pointerId);
    release(value.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    // A destination is sent by a release over the tile; a cancelled or lost press sends nothing.
    if (event.type === "pointerup" && pointer.action === "aim" && pointer.onTile) options.onDestination(cursor.x, cursor.z);
    // A finger lifting leaves nothing hovering.
    if (pointer.type !== "mouse") pointerCursor = false;
    refreshPressed();
    refreshVisibility();
  };

  const cancel = () => {
    for (const pointerId of pointers.keys()) release(pointerId);
    pointers.clear();
    pinchDistance = 0;
    heldKeys.clear();
    pointerCursor = false;
    refreshPressed();
    refreshVisibility();
  };

  const wheel: EventListener = (event) => {
    const value = event as WheelEvent;
    value.preventDefault();
    dolly(goal, Math.exp(value.deltaY * 0.0012), ORBIT_LIMITS);
  };
  const contextMenu: EventListener = (event) => event.preventDefault();
  const pointerEnter: EventListener = (event) => {
    if ((event as PointerEvent).pointerType === "mouse") hovering = true;
  };
  const pointerLeave: EventListener = (event) => {
    hovering = false;
    if ((event as PointerEvent).pointerType === "mouse" && pointers.size === 0) {
      pointerCursor = false;
      refreshVisibility();
    }
  };
  const focus: EventListener = () => {
    focused = true;
    // Focus that a press caused (tracked or ignored) is not keyboard focus.
    if (!pressFocus) keyboardDriven = true;
    pressFocus = false;
    refreshVisibility();
  };
  const blur: EventListener = () => {
    focused = false;
    pressFocus = false;
    cancel();
  };

  const keyDown: EventListener = (event) => {
    const value = event as KeyboardEvent;
    if (value.altKey || value.ctrlKey || value.metaKey) return;
    keyboardDriven = true;
    const tool = options.tool();
    const index = ["1", "2", "3", "4"].indexOf(value.key);
    let handled = true;
    if (index >= 0) {
      options.onTool(TOOLS[index]!);
    } else if (value.key === "p" || value.key === "P") {
      // Holding P must not flicker between paused and running on every auto-repeat.
      if (!value.repeat) options.onPause();
    } else if (value.key === ".") {
      options.onStep();
    } else if (value.key === "+" || value.key === "=") {
      dolly(goal, 0.85, ORBIT_LIMITS);
    } else if (value.key === "-" || value.key === "_") {
      dolly(goal, 1 / 0.85, ORBIT_LIMITS);
    } else if (value.key.startsWith("Arrow")) {
      const dx = value.key === "ArrowLeft" ? -1 : value.key === "ArrowRight" ? 1 : 0;
      const dy = value.key === "ArrowUp" ? 1 : value.key === "ArrowDown" ? -1 : 0;
      if (!isEditTool(tool)) {
        orbit(goal, -dx * 0.12, -dy * 0.08, ORBIT_LIMITS);
      } else {
        // Up moves away from the camera, right moves to the camera's right.
        const stepSize = CURSOR_STEP * (value.shiftKey ? 3 : 1);
        const sin = Math.sin(goal.yaw);
        const cos = Math.cos(goal.yaw);
        cursor.x = clampToTile(cursor.x + (dx * cos - dy * sin) * stepSize, 0.3);
        cursor.z = clampToTile(cursor.z + (-dx * sin - dy * cos) * stepSize, 0.3);
        pointerCursor = false;
      }
    } else if (value.key === "Enter" || value.key === " ") {
      if (tool === "destination") {
        if (!value.repeat) options.onDestination(cursor.x, cursor.z);
      } else if (isEditTool(tool)) {
        heldKeys.add(value.key);
        refreshPressed();
      } else {
        // Orbit has no use for Enter; Space is still kept from scrolling the page under the demo.
        handled = value.key === " ";
      }
    } else {
      handled = false;
    }
    if (handled) {
      value.preventDefault();
      refreshVisibility();
    }
  };
  const keyUp: EventListener = (event) => {
    const value = event as KeyboardEvent;
    if (!heldKeys.delete(value.key)) return;
    refreshPressed();
  };

  const listeners = [
    ["pointerdown", pointerDown, undefined],
    ["pointermove", pointerMove, undefined],
    ["pointerup", pointerUp, undefined],
    ["pointercancel", pointerUp, undefined],
    ["lostpointercapture", pointerUp, undefined],
    ["pointerenter", pointerEnter, undefined],
    ["pointerleave", pointerLeave, undefined],
    ["contextmenu", contextMenu, undefined],
    ["wheel", wheel, { passive: false }],
    ["focus", focus, undefined],
    ["blur", blur, undefined],
    ["keydown", keyDown, undefined],
    ["keyup", keyUp, undefined],
  ] as const;
  let installed = 0;
  try {
    for (const [type, listener, listenerOptions] of listeners) {
      element.addEventListener(type, listener, listenerOptions);
      installed++;
    }
  } catch (error) {
    for (let index = installed - 1; index >= 0; index--) {
      const [type, listener] = listeners[index]!;
      element.removeEventListener(type, listener);
    }
    throw error;
  }

  return {
    cursor,
    get engaged() {
      return hovering || pointers.size > 0 || heldKeys.size > 0;
    },
    get keyboard() {
      return keyboardCursor() && !pointerCursor;
    },
    cancel,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const pointerId of pointers.keys()) release(pointerId);
      for (const [type, listener] of listeners) element.removeEventListener(type, listener);
      pointers.clear();
      hovering = false;
      cursor.pressed = false;
      cursor.visible = false;
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
