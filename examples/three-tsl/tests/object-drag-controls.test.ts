import { beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createObjectDragControls } from "../src/object-drag-controls.ts";

interface MockDragControls {
  readonly objects: THREE.Object3D[];
  readonly object: THREE.Camera;
  transformGroup: boolean;
  rotateSpeed: number;
  mouseButtons: Record<string, THREE.MOUSE | null>;
  touches: Record<string, THREE.TOUCH | null>;
  readonly dispose: ReturnType<typeof vi.fn>;
  emit(type: string): void;
}

const dragState = vi.hoisted(() => ({
  instances: [] as MockDragControls[],
}));

vi.mock("three/addons/controls/DragControls.js", () => ({
  DragControls: class {
    transformGroup = false;
    rotateSpeed = 1;
    mouseButtons = {};
    touches = {};
    dispose = vi.fn();
    private readonly listeners = new Map<string, Set<() => void>>();

    constructor(
      readonly objects: THREE.Object3D[],
      readonly object: THREE.Camera
    ) {
      dragState.instances.push(this);
    }

    addEventListener(type: string, listener: () => void) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: () => void) {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type: string) {
      for (const listener of this.listeners.get(type) ?? []) listener();
    }
  },
}));

describe("createObjectDragControls", () => {
  beforeEach(() => {
    dragState.instances.length = 0;
  });

  it("uses DragControls rotation while keeping the render camera fixed", async () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.2, 4.2);
    camera.lookAt(0, 0, 0);
    const originalPosition = camera.position.clone();
    const originalCameraQuaternion = camera.quaternion.clone();
    const object = new THREE.Group();
    const originalObjectQuaternion = object.quaternion.clone();
    const domElement = { style: { cursor: "" } } as HTMLElement;
    const objectControls = createObjectDragControls(camera, object, domElement);
    const drag = dragState.instances[0]!;

    expect(drag.objects).toEqual([object]);
    expect(drag.object).toBe(camera);
    expect(drag.transformGroup).toBe(true);
    expect(drag.rotateSpeed).toBe(1.5);
    expect(drag.mouseButtons.LEFT).toBe(THREE.MOUSE.ROTATE);
    expect(drag.touches.ONE).toBe(THREE.TOUCH.ROTATE);

    drag.emit("hoveron");
    await Promise.resolve();
    expect(domElement.style.cursor).toBe("grab");
    drag.emit("dragstart");
    expect(domElement.style.cursor).toBe("grabbing");
    drag.emit("dragend");
    await Promise.resolve();
    expect(domElement.style.cursor).toBe("grab");
    drag.emit("hoveroff");
    await Promise.resolve();
    expect(domElement.style.cursor).toBe("");

    const target = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      0.8
    );
    object.quaternion.copy(target);
    drag.emit("drag");

    // DragControls' immediate write is restored so the visible object can
    // ease toward the captured target on animation frames.
    expect(object.quaternion.angleTo(originalObjectQuaternion)).toBeLessThan(
      1e-7
    );
    objectControls.update(0);
    objectControls.update(1_000 / 60);

    expect(object.quaternion.angleTo(originalObjectQuaternion)).toBeGreaterThan(
      0
    );
    expect(object.quaternion.angleTo(target)).toBeLessThan(0.8);
    expect(camera.position.equals(originalPosition)).toBe(true);
    expect(camera.quaternion.equals(originalCameraQuaternion)).toBe(true);

    objectControls.dispose();
    expect(drag.dispose).toHaveBeenCalledOnce();
  });

  it("keeps damping and automatic rotation stable across frame rates", () => {
    const runForOneSecond = (fps: number) => {
      const camera = new THREE.PerspectiveCamera();
      camera.position.z = 4;
      camera.lookAt(0, 0, 0);
      const object = new THREE.Group();
      const objectControls = createObjectDragControls(
        camera,
        object,
        {} as HTMLElement
      );
      const drag = dragState.instances.at(-1)!;

      objectControls.update(0);
      object.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.9);
      drag.emit("drag");
      for (let frame = 1; frame <= fps; frame++) {
        objectControls.update((frame / fps) * 1_000);
      }
      return object.quaternion;
    };

    expect(runForOneSecond(30).angleTo(runForOneSecond(120))).toBeLessThan(
      1e-6
    );
  });

  it("keeps automatic rotation on world Y after the object is flipped", () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.z = 4;
    camera.lookAt(0, 0, 0);
    const object = new THREE.Group();
    const flipped = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI
    );
    object.quaternion.copy(flipped);
    const objectControls = createObjectDragControls(
      camera,
      object,
      {} as HTMLElement
    );

    objectControls.update(0);
    objectControls.update(1_000 / 60);

    const expected = new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.0012)
      .multiply(flipped);
    expect(object.quaternion.angleTo(expected)).toBeLessThan(1e-7);
  });
});
