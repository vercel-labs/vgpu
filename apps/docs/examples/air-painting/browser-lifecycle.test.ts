import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeController {
  readonly key: string;
  label: string;
  disabled: boolean;
  invoke(): unknown;
}

interface FakeGui {
  readonly options: Record<string, unknown>;
  readonly domElement: { readonly style: Record<string, string> };
  readonly controllers: FakeController[];
  destroyed: number;
}

const mocked = vi.hoisted(() => ({
  requestCamera: vi.fn(),
  createCameraRenderer: vi.fn(),
  guis: [] as FakeGui[],
}));

vi.mock("lil-gui", () => ({
  default: class {
    readonly domElement = { style: {} };
    readonly controllers: FakeController[] = [];
    destroyed = 0;

    constructor(readonly options: Record<string, unknown>) {
      mocked.guis.push(this);
    }

    add(object: Record<string, () => unknown>, key: string) {
      const controller: FakeController = {
        key,
        label: key,
        disabled: false,
        invoke: () => object[key]!(),
      };
      Object.assign(controller, {
        name(label: string) {
          controller.label = label;
          return controller;
        },
        disable(disabled = true) {
          controller.disabled = disabled;
          return controller;
        },
      });
      this.controllers.push(controller);
      return controller;
    }

    destroy() {
      this.destroyed++;
    }
  },
}));
vi.mock("./camera-source", () => ({ requestCamera: mocked.requestCamera }));
vi.mock("./ort-runtime", () => ({
  createCameraRenderer: mocked.createCameraRenderer,
}));

import { createRenderer } from "./renderer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const parent = {};
  const renderer = createRenderer({
    canvas: { parentElement: parent } as HTMLCanvasElement,
  });
  const gui = mocked.guis[0]!;
  const controller = (key: string) =>
    gui.controllers.find((item) => item.key === key)!;
  return { renderer, gui, parent, controller };
}

describe("browser controls and lifecycle", () => {
  beforeEach(() => {
    mocked.requestCamera.mockReset();
    mocked.createCameraRenderer.mockReset();
    mocked.guis.length = 0;
  });

  it("mounts only container-scoped lil-gui controls and destroys them once", async () => {
    const { renderer, gui, parent, controller } = setup();
    await renderer.ready;

    expect(gui.options).toMatchObject({
      title: "Air Painting",
      container: parent,
      width: 180,
    });
    expect(gui.controllers.map(({ label }) => label)).toEqual([
      "Enable camera",
      "Stop camera",
      "Clear",
    ]);
    expect(gui.domElement.style).toMatchObject({
      position: "absolute",
      top: "16px",
      right: "16px",
      zIndex: "10",
    });
    expect(controller("enableCamera").disabled).toBe(false);
    expect(controller("stopCamera").disabled).toBe(true);
    expect(controller("clear").disabled).toBe(true);

    renderer.dispose();
    renderer.dispose();
    expect(gui.destroyed).toBe(1);
  });

  it("releases a camera that arrives after the example was disposed", async () => {
    const pending = deferred<{ dispose: ReturnType<typeof vi.fn> }>();
    const camera = { dispose: vi.fn() };
    mocked.requestCamera.mockReturnValue(pending.promise);
    const { renderer, gui, controller } = setup();

    const request = Promise.resolve(controller("enableCamera").invoke());
    expect(controller("enableCamera").disabled).toBe(true);
    renderer.dispose();
    pending.resolve(camera);
    await request;

    expect(camera.dispose).toHaveBeenCalledOnce();
    expect(mocked.createCameraRenderer).not.toHaveBeenCalled();
    expect(gui.destroyed).toBe(1);
  });

  it("enables clear and stop only while a camera renderer is active", async () => {
    const camera = { dispose: vi.fn() };
    const active = {
      ready: Promise.resolve(),
      clear: vi.fn(),
      dispose: vi.fn(),
    };
    mocked.requestCamera.mockResolvedValue(camera);
    mocked.createCameraRenderer.mockReturnValue(active);
    const { controller } = setup();

    await controller("enableCamera").invoke();
    expect(controller("enableCamera").disabled).toBe(true);
    expect(controller("stopCamera").disabled).toBe(false);
    expect(controller("clear").disabled).toBe(false);

    controller("clear").invoke();
    controller("stopCamera").invoke();
    expect(active.clear).toHaveBeenCalledOnce();
    expect(active.dispose).toHaveBeenCalledOnce();
    expect(controller("enableCamera").disabled).toBe(false);
    expect(controller("stopCamera").disabled).toBe(true);
  });

  it("preserves initialization failures and restores the idle controls", async () => {
    const failure = new Error("model failed");
    mocked.requestCamera.mockResolvedValue({ dispose: vi.fn() });
    mocked.createCameraRenderer.mockReturnValue({
      ready: Promise.reject(failure),
      clear: vi.fn(),
      dispose: vi.fn(),
    });
    const { controller } = setup();

    await expect(controller("enableCamera").invoke()).rejects.toBe(failure);
    expect(controller("enableCamera").disabled).toBe(false);
    expect(controller("stopCamera").disabled).toBe(true);
    expect(controller("clear").disabled).toBe(true);
  });

  it("releases the camera when renderer construction throws synchronously", async () => {
    const failure = new Error("renderer construction failed");
    const camera = { dispose: vi.fn() };
    mocked.requestCamera.mockResolvedValue(camera);
    mocked.createCameraRenderer.mockImplementation(() => {
      throw failure;
    });
    const { controller } = setup();

    await expect(controller("enableCamera").invoke()).rejects.toBe(failure);
    expect(camera.dispose).toHaveBeenCalledOnce();
    expect(controller("enableCamera").disabled).toBe(false);
  });

  it("destroys lil-gui even when the active renderer throws during disposal", async () => {
    const failure = new Error("inner dispose failed");
    mocked.requestCamera.mockResolvedValue({ dispose: vi.fn() });
    mocked.createCameraRenderer.mockReturnValue({
      ready: Promise.resolve(),
      clear: vi.fn(),
      dispose: vi.fn(() => {
        throw failure;
      }),
    });
    const { renderer, gui, controller } = setup();
    await controller("enableCamera").invoke();

    expect(() => renderer.dispose()).toThrow(failure);
    expect(gui.destroyed).toBe(1);
  });
});
