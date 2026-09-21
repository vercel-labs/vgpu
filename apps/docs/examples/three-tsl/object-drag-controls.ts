import * as THREE from "three/webgpu";
import { DragControls } from "three/addons/controls/DragControls.js";

const AUTO_ROTATION_RADIANS_PER_SECOND = 0.072;
const DAMPING_RATE = 12;
const MAX_FRAME_DELTA_SECONDS = 0.1;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Uses Three's object-native DragControls for stable camera-space rotation,
 * then damps the visible quaternion toward the dragged target. The render
 * camera is only used for raycasting and never transformed.
 */
export function createObjectDragControls(
  camera: THREE.PerspectiveCamera,
  object: THREE.Group,
  domElement: HTMLElement
) {
  const controls = new DragControls([object], camera, domElement);
  controls.transformGroup = true;
  controls.rotateSpeed = 1.5;
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: null,
    RIGHT: null,
  };
  controls.touches = { ONE: THREE.TOUCH.ROTATE };

  const renderedQuaternion = object.quaternion.clone();
  const targetQuaternion = object.quaternion.clone();
  const draggedQuaternion = new THREE.Quaternion();
  const inverseRenderedQuaternion = new THREE.Quaternion();
  const dragDelta = new THREE.Quaternion();
  const automaticDelta = new THREE.Quaternion();
  let previousFrameTime: number | undefined;
  let hovered = false;
  let dragging = false;

  const updateCursor = () => {
    domElement.style.cursor = dragging ? "grabbing" : hovered ? "grab" : "";
  };
  // DragControls writes `pointer`/`move` around its event dispatches. Updating
  // now and once its handler finishes keeps the cursor semantically correct.
  const scheduleCursorUpdate = () => {
    updateCursor();
    queueMicrotask(updateCursor);
  };
  const handleHoverOn = () => {
    hovered = true;
    scheduleCursorUpdate();
  };
  const handleHoverOff = () => {
    hovered = false;
    scheduleCursorUpdate();
  };
  const handleDragStart = () => {
    dragging = true;
    scheduleCursorUpdate();
  };
  const handleDragEnd = () => {
    dragging = false;
    scheduleCursorUpdate();
  };

  const captureDragTarget = () => {
    draggedQuaternion.copy(object.quaternion);
    inverseRenderedQuaternion.copy(renderedQuaternion).invert();
    dragDelta
      .copy(draggedQuaternion)
      .multiply(inverseRenderedQuaternion);
    targetQuaternion.premultiply(dragDelta).normalize();

    // DragControls applies immediately; restore the displayed orientation so
    // the render loop can ease toward the new target instead of snapping.
    object.quaternion.copy(renderedQuaternion);
  };
  controls.addEventListener("hoveron", handleHoverOn);
  controls.addEventListener("hoveroff", handleHoverOff);
  controls.addEventListener("dragstart", handleDragStart);
  controls.addEventListener("dragend", handleDragEnd);
  controls.addEventListener("drag", captureDragTarget);

  return {
    update(frameTime: number) {
      const deltaSeconds =
        previousFrameTime === undefined
          ? 0
          : Math.min(
              Math.max((frameTime - previousFrameTime) / 1_000, 0),
              MAX_FRAME_DELTA_SECONDS
            );
      previousFrameTime = frameTime;

      automaticDelta.setFromAxisAngle(
        WORLD_UP,
        AUTO_ROTATION_RADIANS_PER_SECOND * deltaSeconds
      );
      targetQuaternion.premultiply(automaticDelta).normalize();
      renderedQuaternion.premultiply(automaticDelta).normalize();

      const damping = 1 - Math.exp(-DAMPING_RATE * deltaSeconds);
      renderedQuaternion.slerp(targetQuaternion, damping).normalize();
      object.quaternion.copy(renderedQuaternion);
    },
    dispose() {
      controls.removeEventListener("hoveron", handleHoverOn);
      controls.removeEventListener("hoveroff", handleHoverOff);
      controls.removeEventListener("dragstart", handleDragStart);
      controls.removeEventListener("dragend", handleDragEnd);
      controls.removeEventListener("drag", captureDragTarget);
      controls.dispose();
    },
  };
}
