import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => ({ init: vi.fn() }));
const guiHarness = vi.hoisted(() => {
  class FakeController {
    label = "";
    enabled = true;
    displays = 0;
    change: ((value: unknown) => void) | undefined;
    /** lil-gui renders a function controller as a <button> inside `domElement`. */
    readonly button = { focus: vi.fn() };
    readonly domElement = { querySelector: vi.fn((selector: string) => (selector === "button" ? this.button : null)) };

    constructor(
      readonly model: Record<string, unknown>,
      readonly property: string,
      readonly choices: unknown
    ) {}

    name(label: string): this {
      this.label = label;
      return this;
    }

    onChange(change: (value: unknown) => void): this {
      this.change = change;
      return this;
    }

    disable(): this {
      this.enabled = false;
      return this;
    }

    enable(enabled = true): this {
      this.enabled = enabled;
      return this;
    }

    updateDisplay(): this {
      this.displays++;
      return this;
    }

    /** What lil-gui does for a click, Enter or Space on a button, or an edited value. */
    activate(value?: unknown): void {
      const current = this.model[this.property];
      if (typeof current === "function") {
        (current as () => void).call(this.model);
        this.change?.(current);
        return;
      }
      this.model[this.property] = value;
      this.change?.(value);
    }
  }

  class FakeFolder {
    _closed = false;
    readonly controllers: FakeController[] = [];
    readonly folders: FakeFolder[] = [];

    constructor(readonly title: string) {}

    add(model: Record<string, unknown>, property: string, choices?: unknown): FakeController {
      const controller = new FakeController(model, property, choices);
      this.controllers.push(controller);
      return controller;
    }

    addFolder(title: string): FakeFolder {
      const folder = new FakeFolder(title);
      this.folders.push(folder);
      return folder;
    }

    close(): this {
      this._closed = true;
      return this;
    }

    open(open = true): this {
      this._closed = !open;
      return this;
    }
  }

  class FakeGui extends FakeFolder {
    readonly domElement = { style: {} as Record<string, string>, matches: vi.fn(() => false) };
    readonly destroy = vi.fn();

    constructor(readonly options: unknown = {}) {
      super("root");
      instances.push(this);
    }

    all(): FakeController[] {
      const found: FakeController[] = [];
      const walk = (folder: FakeFolder) => {
        found.push(...folder.controllers);
        folder.folders.forEach(walk);
      };
      walk(this);
      return found;
    }

    controller(label: string): FakeController {
      const found = this.all().find((candidate) => candidate.label === label);
      if (!found) throw new Error(`No GUI control labelled ${label}`);
      return found;
    }

    folder(title: string): FakeFolder {
      const found = this.folders.find((candidate) => candidate.title === title);
      if (!found) throw new Error(`No GUI folder ${title}`);
      return found;
    }
  }

  const instances: FakeGui[] = [];
  return { FakeGui, instances };
});
const vgpuFns = vi.hoisted(
  () =>
    Object.fromEntries(
      ["surface", "target", "effect", "draw", "geometry", "sampler", "uniforms", "frame", "frameLoop"].map((name) => [
        name,
        // Each test's GPU double carries its factory fakes in `fns`.
        (gpu: { fns: Record<string, (...args: unknown[]) => unknown> }, ...args: unknown[]) => gpu.fns[name]!(...args),
      ])
    ) as Record<string, unknown>
);

vi.mock("lil-gui", () => ({ default: guiHarness.FakeGui }));
vi.mock("vgpu", () => ({
  init: mocks.init,
  ...vgpuFns,
  clock: (gpu: { clock: unknown }) => gpu.clock,
}));
vi.mock("vgpu/scene/gpu", () => ({
  instanceGeometry: (gpu: { fns: { instanceGeometry(...args: unknown[]): unknown } }, collection: unknown, options: unknown) =>
    gpu.fns.instanceGeometry(collection, options),
}));

import { orbitRig, type OrbitRig } from "vgpu/scene";

import { createCity, LIFT_LIMIT, MESHES, NO_SELECTION, type City, type CityInstances } from "./city";
import { SWATCHES, type Mesh } from "./layout";
import { encodePickId, PICK_SIZE, pickViewProjection } from "./picking";
import { createPipeline, HOME_VIEW, type CityPipeline } from "./pipeline";
import { renderThumbnail } from "./render-thumbnail";
import { configureGui, createRenderer, framing } from "./renderer";

type FakeGui = InstanceType<typeof guiHarness.FakeGui>;

interface FakeDraw {
  readonly options: { label: string; geometry: unknown; set: Record<string, unknown> };
}

interface FakeUniforms {
  readonly initial: Record<string, unknown>;
  readonly history: Record<string, unknown>[];
  readonly set: Mock;
}

interface FakeTarget {
  readonly options: { label?: string };
  readonly resize: Mock;
  readonly color: { read: Mock };
}

interface FakeBridge {
  readonly collection: CityInstances;
  readonly geometry: { readonly bridge: true };
  readonly publish: Mock<() => number>;
}

interface PassRecord {
  readonly target: unknown;
  readonly body: unknown;
  readonly draws: { draw: FakeDraw; instances: number | undefined }[];
}

type FakeFrame = ReturnType<typeof fakeFrame>;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function snapshot(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, ArrayBuffer.isView(value) ? Array.from(value as Float32Array) : value])
  );
}

function fakeFrame(done: Promise<void> = Promise.resolve()) {
  const passes: PassRecord[] = [];
  return {
    done,
    passes,
    pass: vi.fn((target: unknown, body: unknown) => {
      const record: PassRecord = { target, body, draws: [] };
      passes.push(record);
      if (typeof body === "function") {
        body({ draw: (draw: FakeDraw, options?: { instances?: number }) => record.draws.push({ draw, instances: options?.instances }) });
      }
    }),
  };
}

function fakeGpu(size: [number, number] = [800, 400]) {
  const draws: FakeDraw[] = [];
  const uniforms: FakeUniforms[] = [];
  const targets: FakeTarget[] = [];
  const bridges: FakeBridge[] = [];
  const loop: { callback?: (frame: FakeFrame) => void; stop: Mock } = { stop: vi.fn() };
  const unsubscribe = vi.fn();
  const pickBytes = { value: new Uint8Array(PICK_SIZE * PICK_SIZE * 4) as Uint8Array };
  const surface = {
    size,
    format: "rgba8unorm",
    onResize: vi.fn((callback: () => void) => {
      callback();
      return unsubscribe;
    }),
  };
  const instance = {
    clock: { time: 2, deltaTime: 1 / 60 },
    gpu: { queue: { onSubmittedWorkDone: vi.fn(async (): Promise<void> => {}) } },
    settled: vi.fn(async (): Promise<void> => {}),
    dispose: vi.fn(),
    fns: {
      surface: vi.fn(() => surface),
      target: vi.fn((options: FakeTarget["options"]) => {
        const created: FakeTarget = { options, resize: vi.fn(), color: { read: vi.fn(async () => pickBytes.value) } };
        targets.push(created);
        return created;
      }),
      effect: vi.fn((_shader: unknown, options: unknown) => ({ options, set: vi.fn() })),
      draw: vi.fn((options: FakeDraw["options"]) => {
        const created: FakeDraw = { options };
        draws.push(created);
        return created;
      }),
      geometry: vi.fn((data: unknown) => ({ data })),
      sampler: vi.fn((options: unknown) => ({ options })),
      uniforms: vi.fn((values: Record<string, unknown>) => {
        const created: FakeUniforms = {
          initial: values,
          history: [],
          set: vi.fn((next: Record<string, unknown>) => created.history.push(snapshot(next))),
        };
        uniforms.push(created);
        return created;
      }),
      frame: vi.fn((callback: (frame: FakeFrame) => void) => {
        const created = fakeFrame();
        callback(created);
        return created;
      }),
      frameLoop: vi.fn((callback: (frame: FakeFrame) => void) => {
        loop.callback = callback;
        return { stop: loop.stop };
      }),
      instanceGeometry: vi.fn((collection: CityInstances) => {
        const created: FakeBridge = {
          collection,
          geometry: { bridge: true },
          publish: vi.fn(() => collection.count),
        };
        bridges.push(created);
        return created;
      }),
    },
  };
  const draw = (label: string) => draws.find((candidate) => candidate.options.label === label)!;
  const target = (label: string) => targets.find((candidate) => candidate.options.label === label)!;
  return {
    instance,
    surface,
    draws,
    uniforms,
    bridges,
    loop,
    unsubscribe,
    pickBytes,
    draw,
    target,
    /** The color pass camera: whatever the part draws bind as `camera`. */
    camera: () => draw("city.parts.box").options.set.camera as FakeUniforms,
    scene: () => draw("city.parts.box").options.set.scene as FakeUniforms,
    run(frame: FakeFrame = fakeFrame()): FakeFrame {
      loop.callback!(frame);
      return frame;
    },
  };
}

/** Offscreen passes take a `{ target, clear }` descriptor; the present pass takes the output itself. */
function passLabel(pass: PassRecord): string {
  const descriptor = pass.target as { target?: FakeTarget };
  return descriptor.target?.options.label ?? "output";
}

function browser(options: { width?: number; height?: number; reducedMotion?: boolean } = {}) {
  const { width = 1280, height = 720 } = options;
  const mediaListeners = new Set<(event: { matches: boolean }) => void>();
  const media = {
    matches: options.reducedMotion ?? false,
    addEventListener: vi.fn((_type: string, listener: (event: { matches: boolean }) => void) => mediaListeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: (event: { matches: boolean }) => void) => mediaListeners.delete(listener)),
  };
  vi.stubGlobal("window", { matchMedia: vi.fn(() => media) });
  const canvasListeners = new Map<string, EventListener>();
  const canvas = {
    clientWidth: width,
    clientHeight: height,
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    addEventListener: vi.fn((type: string, listener: EventListener) => canvasListeners.set(type, listener)),
    removeEventListener: vi.fn((type: string) => canvasListeners.delete(type)),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  };
  const containerListeners = new Map<string, EventListener>();
  const container = {
    clientWidth: width,
    clientHeight: height,
    addEventListener: vi.fn((type: string, listener: EventListener) => containerListeners.set(type, listener)),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (containerListeners.get(type) === listener) containerListeners.delete(type);
    }),
  };
  const tap = (x: number, y: number, pointerType = "mouse") => {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = { type, pointerId: 1, pointerType, button: 0, shiftKey: false, clientX: x, clientY: y, timeStamp: 0 };
      canvasListeners.get(type)!({ ...event, preventDefault: () => {} } as never);
    }
  };
  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    container: container as unknown as HTMLElement,
    canvasListeners,
    containerListeners,
    media,
    mediaListeners,
    tap,
  };
}

/** Starts a renderer on a dpr-2 surface and waits for initialization. */
async function started(options: Parameters<typeof browser>[0] = {}) {
  const page = browser(options);
  const { width = 1280, height = 720 } = options;
  const gpu = fakeGpu([width * 2, height * 2]);
  mocks.init.mockResolvedValueOnce(gpu.instance);
  const renderer = createRenderer({ canvas: page.canvas, container: page.container });
  await renderer.ready;
  const gui = guiHarness.instances.at(-1)!;
  return { page, gpu, renderer, gui };
}

function pickHit(id: number): Uint8Array {
  const bytes = new Uint8Array(PICK_SIZE * PICK_SIZE * 4);
  bytes.set(encodePickId(id), (16 * PICK_SIZE + 16) * 4);
  return bytes;
}

function pipelineFixture(city: City = createCity({ population: 256 })) {
  const gpu = fakeGpu();
  const pipeline = createPipeline(gpu.instance as never, city, [800, 400]);
  pipeline.updateCamera(orbitRig(HOME_VIEW));
  const output = { size: [800, 400] };
  const render = (pick?: { x: number; y: number }) => {
    const frame = fakeFrame();
    const counts = pipeline.render(frame as never, output as never, { pick });
    return { frame, counts };
  };
  return { gpu, city, pipeline, output, render };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  guiHarness.instances.length = 0;
});

describe("modular-city pipeline", () => {
  it("publishes each bridge once per frame and draws that count in every pass", () => {
    const city = createCity({ population: 256 });
    for (const id of city.buildingIds().slice(0, 9)) city.remove(id);
    const { gpu, output, render } = pipelineFixture(city);
    expect(gpu.bridges.map((bridge) => bridge.collection)).toEqual(MESHES.map((mesh) => city.collections[mesh]));

    const { frame, counts } = render({ x: 400, y: 200 });

    const bridgeOf = (mesh: Mesh) => gpu.bridges[MESHES.indexOf(mesh)]!;
    for (const mesh of MESHES) {
      expect(bridgeOf(mesh).publish).toHaveBeenCalledOnce();
      expect(counts[mesh]).toBe(city.collections[mesh].count);
      expect(counts[mesh]).toBeGreaterThan(0);
    }
    expect(frame.passes.map(passLabel)).toEqual(["city.sun-shadow", "city.scene", "city.pick", "output"]);
    expect(frame.passes[3]!.target).toBe(output);
    const labels = frame.passes.map((pass) => pass.draws.map(({ draw }) => draw.options.label));
    const each = (kind: string) => MESHES.map((mesh) => `city.${kind}.${mesh}`);
    expect(labels).toEqual([
      each("shadow"),
      ["city.ground", ...each("parts"), ...each("outline"), ...each("selection-mask"), ...each("ghost")],
      each("pick"),
      [],
    ]);
    let instanced = 0;
    for (const { draw, instances } of frame.passes.flatMap((pass) => pass.draws)) {
      const mesh = draw.options.label.split(".")[2] as Mesh | undefined;
      if (!mesh) {
        expect(instances).toBeUndefined();
        continue;
      }
      instanced++;
      expect(draw.options.geometry).toBe(bridgeOf(mesh).geometry);
      expect(instances).toBe(counts[mesh]);
    }
    expect(instanced).toBe(6 * MESHES.length);
  });

  it("skips empty collections and re-renders the sun shadow only after synced worlds change", () => {
    const city = createCity({ population: 256 });
    for (const id of city.buildingIds()) city.remove(id);
    const { render } = pipelineFixture(city);

    const empty = render({ x: 10, y: 10 });
    expect(empty.counts).toEqual({ box: city.neighborhoods.length, roof: 0, tree: 0 });
    const drawn = empty.frame.passes.flatMap((pass) => pass.draws);
    expect(drawn.filter(({ draw }) => /\.(roof|tree)$/.test(draw.options.label))).toEqual([]);
    expect(drawn.filter(({ draw }) => draw.options.label.endsWith(".box")).map(({ instances }) => instances)).toEqual(
      Array(6).fill(city.neighborhoods.length)
    );

    expect(render().frame.passes.map(passLabel)).toEqual(["city.scene", "output"]);
    city.moveNeighborhood(4, { lift: 1 });
    expect(render().frame.passes.map(passLabel)).toEqual(["city.sun-shadow", "city.scene", "output"]);
    expect(render().frame.passes.map(passLabel)).toEqual(["city.scene", "output"]);
    city.add(4);
    expect(render().frame.passes.map(passLabel)).toEqual(["city.sun-shadow", "city.scene", "output"]);
  });

  it("binds the camera explicitly: color passes share one camera, the pick pass binds its own", () => {
    const { gpu, pipeline, render } = pipelineFixture();
    const camera = gpu.camera();
    const pickCamera = gpu.draw("city.pick.box").options.set.camera as FakeUniforms;

    expect(pickCamera).not.toBe(camera);
    expect(camera.initial.viewProjection).toBe(pipeline.camera.matrices.viewProjection);
    expect(pickCamera.initial.viewProjection).not.toBe(pipeline.camera.matrices.viewProjection);
    for (const kind of ["parts", "outline", "selection-mask", "ghost"]) {
      for (const mesh of MESHES) expect(gpu.draw(`city.${kind}.${mesh}`).options.set.camera).toBe(camera);
    }
    expect(gpu.draw("city.ground").options.set.camera).toBe(camera);
    for (const mesh of MESHES) {
      expect(Object.keys(gpu.draw(`city.pick.${mesh}`).options.set)).toEqual(["camera"]);
      expect(gpu.draw(`city.pick.${mesh}`).options.set.camera).toBe(pickCamera);
      expect(gpu.draw(`city.shadow.${mesh}`).options.set).not.toHaveProperty("camera");
    }

    const point = { x: 612.5, y: 101.25 };
    render(point);
    const expected = Array.from(pickViewProjection(pipeline.camera.matrices.viewProjection, point, [800, 400]));
    const written = pickCamera.history.at(-1)!.viewProjection as number[];
    written.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 5));
    expect(pickCamera.history.at(-1)!.eye).toEqual(Array.from(pipeline.camera.pose.position));

    const writes = pickCamera.set.mock.calls.length;
    expect(render().frame.passes.map(passLabel)).not.toContain("city.pick");
    expect(pickCamera.set).toHaveBeenCalledTimes(writes);
  });

  it("x-rays only the parts of the selection that another building hides", () => {
    const { gpu } = pipelineFixture();
    expect((gpu.target("city.scene").options as { depth?: unknown }).depth).toBe("depth24plus-stencil8");
    for (const mesh of MESHES) {
      const mask = gpu.draw(`city.selection-mask.${mesh}`).options as Record<string, unknown>;
      const ghost = gpu.draw(`city.ghost.${mesh}`).options as Record<string, unknown>;
      // Back faces would pass "greater" behind the selection's own front faces and tint all of it.
      expect(mask.cull).toBe("back");
      expect(ghost.cull).toBe("back");
      expect(mask.writeMask).toEqual([]);
      expect(mask.stencil).toEqual({ front: { pass: "replace" }, ref: 1 });
      expect(ghost.stencil).toEqual({ front: { compare: "not-equal" }, ref: 1 });
      // Complementary depth tests with the same bias: a fragment either marks or tints, never both.
      const maskDepth = mask.depth as Record<string, unknown>;
      const ghostDepth = ghost.depth as Record<string, unknown>;
      expect(maskDepth).toMatchObject({ write: false, compare: "less-equal" });
      expect(ghostDepth).toMatchObject({ write: false, compare: "greater" });
      expect([ghostDepth.bias, ghostDepth.biasSlopeScale]).toEqual([maskDepth.bias, maskDepth.biasSlopeScale]);
      expect(ghost.entry).toEqual(mask.entry);
    }
  });

  it("applies the lens shift off-axis without moving the camera", () => {
    const { gpu, pipeline } = pipelineFixture();
    const rig = orbitRig(HOME_VIEW);
    pipeline.updateCamera(rig, 0);
    const centered = Array.from(pipeline.camera.projection);
    const eye = Array.from(pipeline.camera.pose.position);
    pipeline.updateCamera(rig, -0.25);
    expect(pipeline.camera.projection[8]).toBeCloseTo(centered[8]! + 0.25, 6);
    expect(Array.from(pipeline.camera.projection).filter((_, index) => index !== 8)).toEqual(
      centered.filter((_, index) => index !== 8)
    );
    expect(Array.from(pipeline.camera.pose.position)).toEqual(eye);
    expect(gpu.camera().history.at(-1)!.pixelScale).toBeGreaterThan(0);
  });
});

describe("modular-city renderer lifecycle", () => {
  it("disposing during initialization disposes the late GPU and builds nothing", async () => {
    const page = browser();
    const pending = deferred<ReturnType<typeof fakeGpu>["instance"]>();
    mocks.init.mockReturnValueOnce(pending.promise);
    const renderer = createRenderer({ canvas: page.canvas, container: page.container });
    await vi.waitFor(() => expect(mocks.init).toHaveBeenCalledOnce());
    renderer.dispose();
    const late = fakeGpu();
    pending.resolve(late.instance);
    await expect(renderer.ready).resolves.toBeUndefined();
    expect(late.instance.dispose).toHaveBeenCalledOnce();
    expect(late.instance.fns.surface).not.toHaveBeenCalled();
    expect(late.instance.fns.frameLoop).not.toHaveBeenCalled();
    expect(guiHarness.instances).toHaveLength(0);
    expect(page.canvasListeners.size).toBe(0);
    expect(page.containerListeners.size).toBe(0);
  });

  it("rejects ready on an initialization failure and releases everything installed so far", async () => {
    const page = browser();
    const failing = fakeGpu();
    const error = new Error("frame loop failed");
    failing.instance.fns.frameLoop.mockImplementationOnce(() => {
      throw error;
    });
    mocks.init.mockResolvedValueOnce(failing.instance);
    const renderer = createRenderer({ canvas: page.canvas, container: page.container });
    await expect(renderer.ready).rejects.toBe(error);
    expect(failing.instance.dispose).toHaveBeenCalledOnce();
    expect(guiHarness.instances[0]!.destroy).toHaveBeenCalledOnce();
    expect(failing.unsubscribe).toHaveBeenCalledOnce();
    expect(page.canvasListeners.size).toBe(0);
    expect(page.containerListeners.size).toBe(0);
    expect(page.mediaListeners.size).toBe(0);
  });

  it("dispose is idempotent and releases the loop, resize subscription, listeners, GUI and GPU", async () => {
    const { page, gpu, renderer, gui } = await started();
    expect(gpu.instance.fns.surface).toHaveBeenCalledWith(page.canvas, { dpr: [1, 2] });
    expect(gpu.target("city.scene").resize).toHaveBeenCalledWith([2560, 1440]);
    expect(page.canvasListeners.size).toBe(8);
    expect([...page.containerListeners.keys()]).toEqual(["pointerenter", "pointerleave"]);
    expect(page.mediaListeners.size).toBe(1);
    renderer.dispose();
    renderer.dispose();
    expect(gpu.loop.stop).toHaveBeenCalledOnce();
    expect(gpu.unsubscribe).toHaveBeenCalledOnce();
    expect(gui.destroy).toHaveBeenCalledOnce();
    expect(gpu.instance.dispose).toHaveBeenCalledOnce();
    expect(page.canvasListeners.size).toBe(0);
    expect(page.containerListeners.size).toBe(0);
    expect(page.mediaListeners.size).toBe(0);
  });

  it("a tap renders one pick pass and applies its readback only after that frame is done", async () => {
    const { page, gpu, gui } = await started();
    const read = gpu.target("city.pick").color.read;
    expect(gpu.run().passes.map(passLabel)).not.toContain("city.pick");

    gpu.pickBytes.value = pickHit(1);
    page.tap(640, 360);
    const done = deferred();
    const picked = gpu.run(fakeFrame(done.promise));
    expect(picked.passes.map(passLabel)).toContain("city.pick");
    // The pick window is centered on the tap in device pixels (dpr 2).
    const pickCamera = gpu.draw("city.pick.box").options.set.camera as FakeUniforms;
    expect(pickCamera.history).toHaveLength(1);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();

    done.resolve();
    await vi.waitFor(() => expect(gui.controller("building").model.building).toMatch(/^#1 /));
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({ mipLevel: 0, region: "all" });
    gpu.run();
    expect(gpu.scene().history.at(-1)!.selectedBuilding).toBe(1);
    expect(gpu.run().passes.map(passLabel)).not.toContain("city.pick");
  });

  it("a touch tap searches a fingertip radius that a mouse click does not", async () => {
    const { page, gpu, gui } = await started();
    // A hit 9 device px from the tap: outside the mouse radius (6), inside the touch radius (16).
    const bytes = new Uint8Array(PICK_SIZE * PICK_SIZE * 4);
    bytes.set(encodePickId(1), (16 * PICK_SIZE + 25) * 4);
    gpu.pickBytes.value = bytes;
    const read = gpu.target("city.pick").color.read;

    page.tap(640, 360, "mouse");
    gpu.run();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(gui.controller("building").model.building).toBe("none");

    page.tap(640, 360, "touch");
    gpu.run();
    await vi.waitFor(() => expect(gui.controller("building").model.building).toMatch(/^#1 /));
  });

  it("drops superseded, rebuilt and disposed readbacks", async () => {
    const { page, gpu, gui, renderer } = await started();
    const read = gpu.target("city.pick").color.read;
    const building = gui.controller("building").model;

    page.tap(100, 100);
    const first = deferred();
    gpu.run(fakeFrame(first.promise));
    gpu.pickBytes.value = pickHit(2);
    page.tap(700, 400);
    // One readback at a time: the newer tap waits for the in-flight one.
    expect(gpu.run().passes.map(passLabel)).not.toContain("city.pick");
    first.resolve();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(building.building).toBe("none");
    expect(gpu.run().passes.map(passLabel)).toContain("city.pick");
    await vi.waitFor(() => expect(building.building).toMatch(/^#2 /));

    // A population reset between encode and readback invalidates the pick.
    page.tap(700, 400);
    const rebuilt = deferred();
    gpu.run(fakeFrame(rebuilt.promise));
    gui.controller("reset layout").activate();
    expect(building.building).toBe("none");
    rebuilt.resolve();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(building.building).toBe("none");

    // Disposal before the frame completes skips the readback entirely.
    page.tap(700, 400);
    const late = deferred();
    gpu.run(fakeFrame(late.promise));
    renderer.dispose();
    late.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("a failed readback releases the request and fails the renderer", async () => {
    const queued: (() => void)[] = [];
    const { page, gpu } = await started();
    vi.stubGlobal("queueMicrotask", (callback: () => void) => queued.push(callback));
    const error = new Error("readback lost");
    gpu.target("city.pick").color.read.mockRejectedValueOnce(error);
    page.tap(640, 360);
    gpu.run();
    await vi.waitFor(() => expect(queued).toHaveLength(1));
    expect(() => queued[0]!()).toThrow(error);
    expect(gpu.instance.dispose).toHaveBeenCalledOnce();
    expect(gpu.loop.stop).toHaveBeenCalledOnce();
  });

  it("starts the panel closed on narrow viewports and folds secondary folders on short ones", async () => {
    const phone = await started({ width: 390, height: 844 });
    expect(phone.gui._closed).toBe(true);
    expect(phone.gui.folders.every((folder) => !folder._closed)).toBe(true);
    phone.renderer.dispose();

    const card = await started({ width: 832, height: 468 });
    expect(card.gui._closed).toBe(false);
    expect(card.gui.folders.map((folder) => [folder.title, folder._closed])).toEqual([
      ["Selection", false],
      ["Neighborhood offset", false],
      ["Layout", true],
      ["View", true],
    ]);
    expect(card.gui.options).toMatchObject({ title: "City", container: card.page.container });
    card.renderer.dispose();
  });

  it("idles in a slow orbit and holds still once reduced motion is requested", async () => {
    const { page, gpu } = await started();
    const eyes = () => {
      gpu.run();
      return gpu.camera().history.at(-1)!.eye;
    };
    const first = eyes();
    expect(eyes()).not.toEqual(first);

    for (const listener of page.mediaListeners) listener({ matches: true });
    const settled = eyes();
    expect(eyes()).toEqual(settled);
    expect(eyes()).toEqual(settled);
  });

  it("pauses the idle orbit while the pointer is anywhere over the demo, the panel included", async () => {
    const { page, gpu } = await started();
    const eyes = (frames = 1) => {
      for (let index = 0; index < frames; index++) gpu.run();
      return gpu.camera().history.at(-1)!.eye as number[];
    };
    const moved = (a: number[], b: number[]) => Math.hypot(...a.map((value, index) => value - b[index]!));
    expect(moved(eyes(), eyes())).toBeGreaterThan(0.01);

    // The panel sits in the container, outside the canvas: hovering it enters only the container.
    page.containerListeners.get("pointerenter")!({ pointerType: "mouse" } as never);
    // The camera finishes easing toward the stopped goal, then holds.
    const settled = eyes(240);
    expect(moved(eyes(), settled)).toBeLessThan(1e-6);

    page.containerListeners.get("pointerleave")!({ pointerType: "mouse" } as never);
    expect(moved(eyes(30), settled)).toBeGreaterThan(0.05);
  });

  it("does not orbit at all when reduced motion is already on", async () => {
    const { gpu } = await started({ reducedMotion: true });
    gpu.run();
    const first = gpu.camera().history.at(-1)!.eye;
    gpu.run();
    gpu.run();
    expect(gpu.camera().history.at(-1)!.eye).toEqual(first);
  });
});

describe("modular-city controls", () => {
  function controls(compact = false) {
    const city = createCity({ population: 256 });
    const pipeline = { lighting: { exposure: 1, tiltShift: 1 } } as CityPipeline;
    const goal: OrbitRig = orbitRig(HOME_VIEW);
    const gui = new guiHarness.FakeGui() as FakeGui;
    const run = vi.fn((action: () => void) => action());
    const { settings, sync } = configureGui(gui as never, city, pipeline, goal, run, compact);
    return { city, pipeline, goal, gui, run, settings, sync };
  }

  it("offers every pointer action as a labeled control for keyboard users", () => {
    const { gui } = controls();
    expect(gui.all().map((controller) => controller.label)).toEqual([
      "neighborhood",
      "building",
      "previous building",
      "next building",
      "color",
      "recolor",
      "delete building",
      "add building",
      "x",
      "z",
      "lift",
      "population",
      "buildings",
      "reset layout",
      "idle orbit",
      "tilt-shift",
      "reset view",
    ]);
    expect(gui.folders.every((folder) => !folder._closed)).toBe(true);
    const choices = gui.controller("neighborhood").choices as Record<string, number>;
    expect(Object.values(choices)).toEqual([...Array(16).keys()]);
  });

  it("selects, recolors, deletes, adds and moves through the controls", () => {
    const { city, gui, settings, run } = controls();
    expect(settings.building).toBe("none");
    expect(gui.controller("recolor").enabled).toBe(false);
    expect(gui.controller("delete building").enabled).toBe(false);

    gui.controller("neighborhood").activate(3);
    expect(city.selection.neighborhood).toBe(3);
    gui.controller("next building").activate();
    const ids = city.buildingIds(3);
    expect(city.selection.building).toBe(ids[0]);
    const record = city.building(ids[0]!)!;
    expect(settings.building).toBe(`#${record.id} ${record.kind}`);
    expect(gui.controller("recolor").enabled).toBe(true);
    gui.controller("previous building").activate();
    expect(city.selection.building).toBe(ids.at(-1));
    gui.controller("next building").activate();

    const swatch = record.swatch;
    gui.controller("recolor").activate();
    expect(record.swatch).toBe((swatch + 1) % SWATCHES.length);
    expect(settings.swatch).toBe(SWATCHES[record.swatch]!.name);

    gui.controller("x").activate(0.6);
    gui.controller("lift").activate(LIFT_LIMIT);
    expect(city.neighborhoods[3]!.offset).toEqual({ x: 0.6, z: 0, lift: LIFT_LIMIT });

    const count = settings.buildings;
    gui.controller("delete building").activate();
    expect(city.building(record.id)).toBeUndefined();
    expect(settings.buildings).toBe(count - (record.kind === "grove" ? 0 : 1));
    // The selection moves to the building that followed, so a keyboard user can delete again.
    expect(city.selection.building).toBe(ids[1]);
    expect(settings.building).toMatch(new RegExp(`^#${ids[1]} `));
    expect(gui.controller("delete building").enabled).toBe(true);
    expect(gui.controller("add building").enabled).toBe(true);
    city.select(record.id);

    const hood = city.neighborhoods[3]!;
    const free = hood.plan.lots.find((lot) => !hood.occupied.has(lot.index))!.index;
    gui.controller("add building").activate();
    expect(city.selection.building).toBeGreaterThan(record.id);
    expect(city.building(city.selection.building)!.lot).toBe(free);
    expect(run).toHaveBeenCalled();
  });

  it("keeps keyboard focus in the panel when a delete empties or an add fills a neighborhood", () => {
    const { city, gui } = controls();
    gui.controller("neighborhood").activate(5);
    gui.controller("next building").activate();
    const remove = gui.controller("delete building");
    const add = gui.controller("add building");
    const ids = city.buildingIds(5);
    for (const [position, id] of ids.entries()) {
      expect(city.selection.building).toBe(id);
      remove.activate();
      expect(add.button.focus).toHaveBeenCalledTimes(position === ids.length - 1 ? 1 : 0);
    }
    expect(city.buildingIds(5)).toEqual([]);
    expect(remove.enabled).toBe(false);
    expect(add.enabled).toBe(true);

    const hood = city.neighborhoods[5]!;
    while (hood.occupied.size < hood.plan.lots.length - 1) add.activate();
    expect(remove.button.focus).not.toHaveBeenCalled();
    add.activate();
    expect(add.enabled).toBe(false);
    expect(remove.enabled).toBe(true);
    expect(remove.button.focus).toHaveBeenCalledOnce();
  });

  it("resets the layout, population, view and lens settings", () => {
    const { city, gui, settings, goal, pipeline } = controls();
    gui.controller("neighborhood").activate(2);
    gui.controller("z").activate(-0.4);
    gui.controller("population").activate(512);
    expect(city.plan.population).toBe(512);
    expect(city.generation).toBe(2);
    expect(settings.z).toBe(0);
    expect(settings.neighborhood).toBe(5);
    gui.controller("reset layout").activate();
    expect(city.plan.population).toBe(512);
    expect(city.generation).toBe(3);

    gui.controller("tilt-shift").activate(0.3);
    expect(pipeline.lighting.tiltShift).toBe(0.3);

    goal.yaw += 2;
    goal.distance = 60;
    goal.pan[0] = 9;
    gui.controller("reset view").activate();
    expect({ yaw: goal.yaw, pitch: goal.pitch, distance: goal.distance, pan: [...goal.pan], target: [...goal.target] }).toEqual({
      yaw: HOME_VIEW.yaw,
      pitch: HOME_VIEW.pitch,
      distance: HOME_VIEW.distance,
      pan: [0, 0, 0],
      target: [...HOME_VIEW.target],
    });
  });

  it("sync reflects a pointer pick without replacing controllers", () => {
    const { city, gui, settings, sync } = controls();
    const neighborhood = gui.controller("neighborhood");
    const change = neighborhood.change;
    const id = city.buildingIds(9)[0]!;
    city.select(id);
    sync();
    expect(settings.neighborhood).toBe(9);
    expect(settings.building).toMatch(new RegExp(`^#${id} `));
    expect(gui.controller("neighborhood")).toBe(neighborhood);
    expect(neighborhood.change).toBe(change);
    expect(neighborhood.displays).toBeGreaterThan(1);
    neighborhood.activate(0);
    expect(city.selection).toEqual({ building: NO_SELECTION, neighborhood: 0 });
  });

  it("folds the layout and view folders in compact frames", () => {
    const { gui } = controls(true);
    expect(gui.folders.map((folder) => folder._closed)).toEqual([false, false, true, true]);
  });

  it("frames the board beside the open panel and dollies out on narrow frames", () => {
    const open = framing(1280, 720, 0);
    expect(open.shift).toBeCloseTo(0, 6);
    expect(open.fit).toBe(1);
    const beside = framing(1280, 720, 256);
    expect(beside.shift).toBeCloseTo(-0.2, 6);
    expect(beside.fit).toBe(1);
    const card = framing(832, 468, 256);
    expect(card.shift).toBeCloseTo(-256 / 832, 6);
    expect(card.fit).toBeCloseTo((1.28 * 468) / 576, 6);
    expect(framing(390, 844, 0).fit).toBe(2.4);
    expect(framing(0, 0, 0)).toEqual({ shift: 0, fit: 1.28 });
  });
});

describe("modular-city thumbnail", () => {
  it("renders one frame of the lifted, selected downtown through the shared pipeline", async () => {
    const gpu = fakeGpu([1280, 720]);
    const output = { size: [1280, 720] };
    await renderThumbnail(gpu.instance as never, output as never, { warmupFrames: 60 });
    expect(gpu.instance.fns.frame).toHaveBeenCalledOnce();
    const frame = gpu.instance.fns.frame.mock.results[0]!.value as FakeFrame;
    expect(frame.passes.map(passLabel)).toEqual(["city.sun-shadow", "city.scene", "output"]);
    expect(frame.passes[2]!.target).toBe(output);
    expect(gpu.target("city.scene").resize).toHaveBeenCalledWith([1280, 720]);
    expect(gpu.scene().history.at(-1)).toMatchObject({ selectedNeighborhood: 6, outlineWidth: 3 });
    expect(gpu.scene().history.at(-1)!.selectedBuilding).toBeGreaterThan(0);
    expect(gpu.instance.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
    expect(gpu.instance.settled).toHaveBeenCalledOnce();
    expect(gpu.instance.dispose).not.toHaveBeenCalled();
  });

  it("waits for both GPU drains before reporting a failure", async () => {
    const gpu = fakeGpu([1280, 720]);
    const error = new Error("render failed");
    const drain = deferred();
    const settled = deferred();
    gpu.instance.gpu.queue.onSubmittedWorkDone.mockImplementationOnce(() => drain.promise);
    gpu.instance.settled.mockImplementationOnce(() => settled.promise);
    gpu.instance.fns.frame.mockImplementationOnce(() => {
      throw error;
    });
    const rendering = renderThumbnail(gpu.instance as never, { size: [1280, 720] } as never);
    let finished = false;
    void rendering.then(
      () => (finished = true),
      () => (finished = true)
    );
    await vi.waitFor(() => {
      expect(gpu.instance.gpu.queue.onSubmittedWorkDone).toHaveBeenCalledOnce();
      expect(gpu.instance.settled).toHaveBeenCalledOnce();
    });
    expect(finished).toBe(false);
    drain.resolve();
    settled.resolve();
    await expect(rendering).rejects.toBe(error);
  });
});
