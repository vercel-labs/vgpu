import { afterEach, expect, test, vi } from "vitest";

import type { Colony } from "./colony";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  colonies: [] as unknown[],
  /** brush.active seen by every renderer-driven step() (the GUI/keyboard single step). */
  manualSteps: [] as boolean[],
  createPipeline: vi.fn(),
}));

const guiHarness = vi.hoisted(() => {
  interface Control {
    object: Record<string, unknown>;
    property: string;
    label?: string;
    change?: (value: unknown) => unknown;
    name(label: string): Control;
    onChange(change: (value: unknown) => unknown): Control;
    onFinishChange(change: (value: unknown) => unknown): Control;
    decimals(): Control;
    disable(): Control;
    enabled: boolean;
    enable(enabled?: boolean): Control;
    updateDisplay(): Control;
  }
  class FakeGui {
    options: unknown;
    _title: string;
    closed = false;
    domElement = { style: {} as Record<string, string>, matches: () => false };
    destroy = vi.fn();
    folders: FakeGui[] = [];
    controls: Control[];

    constructor(options: { title?: string } = {}, controls: Control[] = []) {
      this.options = options;
      this._title = options.title ?? "";
      this.controls = controls;
      if (!controls.length) instances.push(this);
    }

    addFolder(title: string): FakeGui {
      const folder = new FakeGui({ title }, this.controls);
      this.folders.push(folder);
      return folder;
    }

    close(): this {
      this.closed = true;
      return this;
    }

    add(object: Record<string, unknown>, property: string): Control {
      const control: Control = {
        object,
        property,
        name(label) {
          control.label = label;
          return control;
        },
        onChange(change) {
          control.change = change;
          return control;
        },
        onFinishChange(change) {
          control.change = change;
          return control;
        },
        decimals: () => control,
        disable: () => control,
        enabled: true,
        enable(enabled = true) {
          control.enabled = enabled;
          return control;
        },
        updateDisplay: () => control,
      };
      this.controls.push(control);
      return control;
    }

    control(label: string): Control {
      const found = this.controls.find((candidate) => candidate.label === label);
      if (!found) throw new Error(`No GUI control labelled ${label}`);
      return found;
    }

    press(label: string): void {
      const control = this.control(label);
      (control.object[control.property] as () => void)();
    }

    set(label: string, value: unknown): void {
      const control = this.control(label);
      control.object[control.property] = value;
      control.change?.(value);
    }
  }
  const instances: FakeGui[] = [];
  return { FakeGui, instances };
});

const toolbarHarness = vi.hoisted(() => {
  const instances: {
    options: import("./toolbar").ToolbarOptions;
    element: object;
    adjusting: boolean;
    setTool: ReturnType<typeof vi.fn>;
    setDestination: ReturnType<typeof vi.fn>;
    setPaused: ReturnType<typeof vi.fn>;
    layout: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  const createToolbar = (_container: unknown, options: import("./toolbar").ToolbarOptions) => {
    const toolbar = {
      options,
      element: {},
      adjusting: false,
      setTool: vi.fn(),
      setDestination: vi.fn(),
      setPaused: vi.fn(),
      layout: vi.fn(),
      dispose: vi.fn(),
    };
    instances.push(toolbar);
    return toolbar;
  };
  return { instances, createToolbar };
});

vi.mock("lil-gui", () => ({ default: guiHarness.FakeGui }));
vi.mock("./toolbar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./toolbar")>()),
  createToolbar: toolbarHarness.createToolbar,
}));
vi.mock("vgpu", () => ({
  init: mocks.init,
  surface: (gpu: any, ...args: unknown[]) => gpu.fns.surface(...args),
  frameLoop: (gpu: any, callback: unknown) => gpu.fns.frameLoop(callback),
  frame: (gpu: any, callback: unknown) => gpu.fns.frame(callback),
  clock: (gpu: any) => gpu.clock,
}));
vi.mock("./pipeline", () => ({ createPipeline: mocks.createPipeline }));
vi.mock("./colony", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./colony")>();
  return {
    ...actual,
    createColony: (...args: Parameters<typeof actual.createColony>) => {
      const colony = actual.createColony(...args);
      mocks.colonies.push(colony);
      return colony;
    },
    step: (colony: Colony) => {
      mocks.manualSteps.push(colony.brush.active);
      actual.step(colony);
    },
  };
});

import { FIXED_DT } from "./colony";
import { renderThumbnail, THUMB_STEPS } from "./render-thumbnail";
import { createRenderer, REDUCED_PACE } from "./renderer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakePipeline() {
  return {
    camera: { pose: { position: [0, 4, 8], quaternion: [0, 0, 0, 1] } },
    lens: { fov: 40, near: 0.1, far: 100 },
    counters: { instances: 0, terrainBytes: 0, rigRows: 0 },
    resize: vi.fn(),
    updateCamera: vi.fn(),
    render: vi.fn(),
  };
}

function listenerTarget(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    listeners,
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    addEventListener: vi.fn((type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(type: string, event: Record<string, unknown> = {}) {
      for (const listener of listeners.get(type) ?? []) listener({ type, preventDefault() {}, ...event } as unknown as Event);
    },
    ...extra,
  };
}

function setup(options: { reducedMotion?: boolean; width?: number; height?: number } = {}) {
  const motion = listenerTarget({ matches: options.reducedMotion ?? false });
  const window = listenerTarget({ matchMedia: vi.fn(() => motion) });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", { activeElement: null });

  const container = listenerTarget({ clientWidth: options.width ?? 1280, clientHeight: options.height ?? 720 });
  const canvas = listenerTarget({
    parentElement: container,
    clientHeight: options.height ?? 720,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: options.width ?? 1280, height: options.height ?? 720 }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
  });

  const unsubscribeResize = vi.fn();
  const output = {
    size: [options.width ?? 1280, options.height ?? 720] as [number, number],
    format: "rgba8unorm",
    onResize: vi.fn((callback: () => void) => {
      callback();
      return unsubscribeResize;
    }),
  };
  const stop = vi.fn();
  let liveFrame: ((frame: unknown) => void) | undefined;
  const pipeline = fakePipeline();
  mocks.createPipeline.mockImplementation(() => pipeline);
  const gpu = {
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async () => {}) } },
    settled: vi.fn(async () => {}),
    dispose: vi.fn(),
    clock: { time: 0, deltaTime: FIXED_DT, frameCount: 0 },
    fns: {
      surface: vi.fn(() => output),
      frameLoop: vi.fn((callback: (frame: unknown) => void) => {
        liveFrame = callback;
        return { stop };
      }),
      frame: vi.fn((callback: (frame: unknown) => void) => {
        callback({});
        return { done: Promise.resolve() };
      }),
    },
  };
  mocks.init.mockResolvedValueOnce(gpu);
  return {
    motion,
    window,
    container,
    canvas,
    output,
    unsubscribeResize,
    stop,
    pipeline,
    gpu,
    gui: () => guiHarness.instances[0]!,
    toolbar: () => toolbarHarness.instances.at(-1)!,
    colony: () => mocks.colonies.at(-1) as Colony,
    runFrame: () => liveFrame?.({}),
    lastBrush: () => pipeline.render.mock.calls.at(-1)?.[2].brush as number[],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.init.mockReset();
  mocks.createPipeline.mockReset();
  mocks.colonies.length = 0;
  mocks.manualSteps.length = 0;
  guiHarness.instances.length = 0;
  toolbarHarness.instances.length = 0;
});

test("initializes, steps the colony on the fixed clock and renders every frame", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;

  expect(env.gpu.fns.surface).toHaveBeenCalledWith(env.canvas, { dpr: [1, 2] });
  expect(env.pipeline.resize).toHaveBeenCalledOnce();
  const gui = env.gui();
  expect(gui.options).toMatchObject({ container: env.container, title: "Settings" });
  expect(gui.domElement.style.position).toBe("absolute");
  // lil-gui keeps advanced settings only: no tool selector and no one-shot sculpt actions.
  expect(gui.folders.map((folder) => folder._title)).toEqual(["Scene", "Camera", "Debug", "Stats"]);
  expect(gui.control("planted IK residual")).toBeDefined();
  expect(gui.controls.some((control) => control.property === "tool" || /raise|lower|elevate/.test(control.label ?? ""))).toBe(false);
  expect(env.toolbar().options).toMatchObject({ tool: "orbit", touch: false });
  // The tools precede the Settings panel in the container, so they come first in tab order.
  expect(env.toolbar().options.before).toBe(gui.domElement);
  expect(env.toolbar().layout).toHaveBeenCalledWith(1280);
  // Docked at the bottom, Settings stops 8 px above the bar (8 px margins top and bottom).
  env.toolbar().options.onDock!(120);
  expect(gui.domElement.style.maxHeight).toBe("calc(100% - 144px)");
  env.toolbar().options.onDock!(null);
  expect(gui.domElement.style.maxHeight).toBe("calc(100% - 16px)");
  expect(env.canvas.count()).toBe(13);
  expect(env.container.count()).toBe(2);
  expect(env.window.count()).toBe(1);
  expect(env.motion.count()).toBe(1);

  for (let index = 0; index < 3; index++) env.runFrame();
  expect(env.colony().steps).toBe(3);
  expect(env.pipeline.updateCamera).toHaveBeenCalledTimes(3);
  expect(env.pipeline.render).toHaveBeenCalledTimes(3);
  expect(env.lastBrush()[3]).toBe(0);
  renderer.dispose();
});

test("stats report instances and per-second upload rates from the pipeline counters", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  const gui = env.gui();
  // The first frame refreshes the readout; then count exactly 0.5 s (8 × 1/16 s) of uploads.
  env.runFrame();
  env.gpu.clock.deltaTime = 1 / 16;
  for (let index = 0; index < 8; index++) {
    env.pipeline.counters.instances = 640;
    env.pipeline.counters.terrainBytes += 1024;
    env.pipeline.counters.rigRows += 10;
    env.runFrame();
  }
  expect(gui.control("instances drawn").object.instances).toBe("640");
  expect(gui.control("terrain upload").object.terrain).toBe("16.0 KB/s");
  expect(gui.control("robot parts upload").object.rig).toBe("160 rows/s");
  renderer.dispose();
});

test("dispose is idempotent and releases listeners, the GUI, the loop and the GPU once", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  renderer.dispose();
  renderer.dispose();

  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.unsubscribeResize).toHaveBeenCalledOnce();
  expect(env.canvas.count()).toBe(0);
  expect(env.container.count()).toBe(0);
  expect(env.window.count()).toBe(0);
  expect(env.motion.count()).toBe(0);
  expect(env.toolbar().dispose).toHaveBeenCalledOnce();
  expect(env.gui().destroy).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("a GPU that arrives after dispose is released without creating anything", async () => {
  const env = setup();
  const init = deferred<typeof env.gpu>();
  mocks.init.mockReset().mockReturnValueOnce(init.promise);
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
  renderer.dispose();
  init.resolve(env.gpu);
  await renderer.ready;

  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.gpu.fns.surface).not.toHaveBeenCalled();
  expect(guiHarness.instances).toHaveLength(0);
});

test("initialization failure rejects ready and tears down what was created", async () => {
  const env = setup();
  mocks.createPipeline.mockImplementation(() => {
    throw new Error("pipeline failed");
  });
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await expect(renderer.ready).rejects.toThrow("pipeline failed");
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.canvas.count()).toBe(0);
  expect(env.container.count()).toBe(0);
  renderer.dispose();
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
});

test("a throwing frame disposes once and rethrows", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  env.pipeline.render.mockImplementationOnce(() => {
    throw new Error("render failed");
  });
  expect(() => env.runFrame()).toThrow("render failed");
  expect(env.gpu.dispose).toHaveBeenCalledOnce();
  expect(env.stop).toHaveBeenCalledOnce();
  expect(env.gui().destroy).toHaveBeenCalledOnce();
  // A late loop callback after the failure does nothing.
  env.runFrame();
  expect(env.pipeline.render).toHaveBeenCalledOnce();
});

/** Records the smoothed camera handed to the pipeline each frame. */
function cameraLog(env: ReturnType<typeof setup>) {
  const poses: number[][] = [];
  env.pipeline.updateCamera.mockImplementation((rig: { target: number[]; pan: number[]; yaw: number; pitch: number; distance: number }) => {
    poses.push([...rig.target, ...rig.pan, rig.yaw, rig.pitch, rig.distance]);
  });
  return poses;
}

test("an edit tool holds the camera still and suspends follow and idle orbit until Orbit returns", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  const gui = env.gui();
  const toolbar = env.toolbar();
  const poses = cameraLog(env);
  gui.set("follow robot 1", true);
  for (let index = 0; index < 4; index++) env.runFrame();
  // Orbit: idle orbit turns the camera and follow pulls it toward robot 1.
  expect(poses[3]![6]).toBeGreaterThan(poses[0]![6]!);

  for (const tool of ["elevate", "lower", "destination"] as const) {
    toolbar.options.onTool(tool);
    expect(toolbar.setTool).toHaveBeenLastCalledWith(tool);
    expect(gui.control("follow robot 1").enabled).toBe(false);
    expect(gui.control("idle orbit").enabled).toBe(false);
    poses.length = 0;
    for (let index = 0; index < 30; index++) env.runFrame();
    // The glide target snapped to the current camera, and nothing moves it while editing (the
    // smoothing only adds rounding).
    for (const pose of poses) pose.forEach((value, index) => expect(value).toBeCloseTo(poses[0]![index]!, 12));
  }

  toolbar.options.onTool("orbit");
  expect(toolbar.setTool).toHaveBeenLastCalledWith("orbit");
  expect(gui.control("follow robot 1").enabled).toBe(true);
  expect(gui.control("idle orbit").enabled).toBe(true);
  poses.length = 0;
  for (let index = 0; index < 4; index++) env.runFrame();
  expect(poses[3]![6]).toBeGreaterThan(poses[0]![6]!);
  renderer.dispose();
});

test("re-picking the active tool is a no-op, and switching tools drops a held sculpt", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  const colony = env.colony();
  env.canvas.dispatch("focus");
  env.canvas.dispatch("keydown", { key: "2" });
  expect(env.toolbar().setTool).toHaveBeenCalledOnce();
  env.canvas.dispatch("keydown", { key: "2" });
  expect(env.toolbar().setTool).toHaveBeenCalledOnce();

  env.canvas.dispatch("keydown", { key: "Enter" });
  const revision = colony.terrain.revision;
  env.runFrame();
  expect(colony.terrain.revision).toBeGreaterThan(revision);
  env.toolbar().options.onTool("orbit");
  const afterSwitch = colony.terrain.revision;
  for (let index = 0; index < 5; index++) env.runFrame();
  expect(colony.terrain.revision).toBe(afterSwitch);
  expect(colony.brush.active).toBe(false);
  renderer.dispose();
});

test("window blur releases a held keyboard sculpt", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  const colony = env.colony();
  env.canvas.dispatch("focus");
  env.canvas.dispatch("keydown", { key: "3" });
  env.canvas.dispatch("keydown", { key: " " });
  env.runFrame();
  expect(colony.brush.active).toBe(true);
  expect(colony.brush.mode).toBe("lower");
  env.window.dispatch("blur");
  const revision = colony.terrain.revision;
  for (let index = 0; index < 5; index++) env.runFrame();
  expect(colony.terrain.revision).toBe(revision);
  expect(colony.brush.active).toBe(false);
  renderer.dispose();
});

test("the aim overlay shows each edit tool's style, even while paused, and hides in Orbit", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  const gui = env.gui();
  gui.set("paused", true);
  env.canvas.dispatch("focus");
  for (const [key, style] of [
    ["2", 1],
    ["3", -1],
    ["4", 2],
    ["1", 0],
  ] as const) {
    env.canvas.dispatch("keydown", { key });
    env.runFrame();
    expect(env.lastBrush()[3]).toBe(style);
  }
  expect(env.colony().steps).toBe(0);
  renderer.dispose();
});

test("a paused sculpt advances only with single steps", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  const gui = env.gui();
  const colony = env.colony();
  gui.set("paused", true);
  env.canvas.dispatch("focus");
  env.canvas.dispatch("keydown", { key: "2" });
  env.canvas.dispatch("keydown", { key: "Enter" });
  const revision = colony.terrain.revision;
  for (let index = 0; index < 20; index++) env.runFrame();
  expect(colony.terrain.revision).toBe(revision);
  // The tool bar is told every frame, so it can explain why the drag does nothing yet.
  expect(env.toolbar().setPaused).toHaveBeenLastCalledWith(true);
  for (let index = 0; index < 3; index++) gui.press("step once");
  expect(mocks.manualSteps).toEqual([true, true, true]);
  expect(colony.terrain.revision).toBe(revision + 3);
  env.canvas.dispatch("keyup", { key: "Enter" });
  gui.press("step once");
  expect(mocks.manualSteps.at(-1)).toBe(false);
  expect(colony.terrain.revision).toBe(revision + 3);
  renderer.dispose();
});

test("the destination tool and the tool bar's clear button drive the colony destination", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  const colony = env.colony();
  env.canvas.dispatch("focus");
  env.canvas.dispatch("keydown", { key: "4" });
  env.canvas.dispatch("keydown", { key: "Enter" });
  expect(colony.destination.active).toBe(true);
  env.runFrame();
  expect(env.toolbar().setDestination).toHaveBeenLastCalledWith(true);
  env.toolbar().options.onClearDestination();
  expect(colony.destination.active).toBe(false);
  env.runFrame();
  expect(env.toolbar().setDestination).toHaveBeenLastCalledWith(false);
  renderer.dispose();
});

test("the tool bar's brush sliders set the sculpt radius and strength", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  env.toolbar().options.onRadius(1.7);
  env.toolbar().options.onStrength(0.4);
  env.runFrame();
  expect(env.colony().brush.radius).toBe(1.7);
  expect(env.colony().brush.strength).toBe(0.4);
  renderer.dispose();
});

test("reduced motion sets calm defaults and leaves values the user changed alone", async () => {
  const env = setup({ reducedMotion: true });
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  const gui = env.gui();
  const pace = gui.control("pace");
  const idle = gui.control("idle orbit");
  expect(pace.object.pace).toBe(REDUCED_PACE);
  expect(env.colony().pace).toBe(REDUCED_PACE);
  expect(idle.object.autoOrbit).toBe(false);

  env.motion.dispatch("change", { matches: false });
  expect(pace.object.pace).toBe(1);
  expect(idle.object.autoOrbit).toBe(true);

  gui.set("pace", 0.7);
  gui.set("idle orbit", false);
  env.motion.dispatch("change", { matches: true });
  env.motion.dispatch("change", { matches: false });
  expect(pace.object.pace).toBe(0.7);
  expect(env.colony().pace).toBe(0.7);
  expect(idle.object.autoOrbit).toBe(false);
  renderer.dispose();
});

test("narrow and short frames start with the panel or its folders closed", async () => {
  const phone = setup({ width: 390, height: 844 });
  const first = createRenderer({ canvas: phone.canvas as unknown as HTMLCanvasElement });
  await first.ready;
  expect(phone.gui().closed).toBe(true);
  first.dispose();
  guiHarness.instances.length = 0;

  // The tool bar docks to the bottom below the same width, so 650–719 px close the panel too.
  for (const width of [650, 680]) {
    const tablet = setup({ width, height: 900 });
    const renderer = createRenderer({ canvas: tablet.canvas as unknown as HTMLCanvasElement });
    await renderer.ready;
    expect(tablet.gui().closed).toBe(true);
    renderer.dispose();
    guiHarness.instances.length = 0;
  }

  const embed = setup({ width: 832, height: 468 });
  const second = createRenderer({ canvas: embed.canvas as unknown as HTMLCanvasElement });
  await second.ready;
  expect(embed.gui().closed).toBe(false);
  expect(embed.gui().folders.every((folder) => folder.closed)).toBe(true);
  second.dispose();
});

test("keyboard step and pause reach the colony", async () => {
  const env = setup();
  const renderer = createRenderer({ canvas: env.canvas as unknown as HTMLCanvasElement });
  await renderer.ready;
  env.canvas.dispatch("keydown", { key: "p", altKey: false, ctrlKey: false, metaKey: false });
  expect(env.colony().paused).toBe(true);
  env.canvas.dispatch("keydown", { key: ".", altKey: false, ctrlKey: false, metaKey: false });
  expect(env.colony().steps).toBe(1);
  env.runFrame();
  expect(env.colony().steps).toBe(1);
  expect(env.toolbar().setPaused).toHaveBeenLastCalledWith(true);
  env.canvas.dispatch("keydown", { key: "p", altKey: false, ctrlKey: false, metaKey: false });
  env.runFrame();
  expect(env.toolbar().setPaused).toHaveBeenLastCalledWith(false);
  renderer.dispose();
});

test("thumbnail renders one frame of the stepped colony and waits for both drains", async () => {
  const env = setup();
  const output = { size: [320, 180] as const, format: "rgba8unorm" };
  await renderThumbnail(env.gpu as never, output as never);
  expect(env.colony().steps).toBe(THUMB_STEPS);
  expect(env.gpu.fns.frame).toHaveBeenCalledOnce();
  expect(env.pipeline.render).toHaveBeenCalledOnce();
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
  expect(env.gpu.dispose).not.toHaveBeenCalled();
});

test("thumbnail still drains when rendering fails", async () => {
  const env = setup();
  mocks.createPipeline.mockImplementation(() => {
    throw new Error("pipeline failed");
  });
  await expect(renderThumbnail(env.gpu as never, { size: [320, 180] } as never)).rejects.toThrow("pipeline failed");
  expect(env.gpu.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
  expect(env.gpu.settled).toHaveBeenCalledOnce();
});
