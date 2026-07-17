import { afterEach, expect, test, vi } from "vitest";
import { init } from "../src/mock.ts";

const RAW_GROUP_SHADER = `
struct Globals { tint: f32 }
struct Obj { value: f32 }
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> obj: Obj;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(obj.value * globals.tint, uv, 1.0);
}
`;

const SIMPLE_SHADER = `
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.0, 1.0);
}
`;

afterEach(() => vi.restoreAllMocks());

test("Draw.draw returns void while claimed group validation errors go to gpu.onError", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const { draw, popResolvers } = rawClaimedDrawWithDeferredScopes(gpu, "drawVoid");
  const errors: unknown[] = [];
  gpu.onError((error) => errors.push(error));

  const result = draw.draw({ target, offsets: { 1: [0] } });
  expect(result).toBeUndefined();

  resolveRawClaimFailure(popResolvers, "raw group mismatch");
  await gpu.settled();

  expect(errors).toEqual([
    expect.objectContaining({
      code: "VGPU-R4-GROUP-VALIDATION",
      where: "drawVoid.draw",
      detail: { drawLabel: "drawVoid", group: 1 },
    }),
  ]);
  gpu.dispose();
});

test("Frame.done resolves after R4 validation is delivered exactly once through gpu.onError", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const { draw, popResolvers } = rawClaimedDrawWithDeferredScopes(gpu, "frameDone");
  const errors: unknown[] = [];
  gpu.onError((error) => errors.push(error));

  const frame = gpu.frame((f) => f.pass({ target }, (p) => p.draw(draw, { offsets: { 1: [0] } })));
  const done = expect(frame.done).resolves.toBeUndefined();

  resolveRawAndFinalizeFailures(popResolvers, "frame raw group mismatch");
  await done;
  await gpu.settled();

  expect(errors).toHaveLength(1);
  expect(errors).toEqual([
    expect.objectContaining({
      code: "VGPU-R4-GROUP-VALIDATION",
      where: "frameDone.draw",
      detail: { drawLabel: "frameDone", group: 1 },
    }),
  ]);
  gpu.dispose();
});

test("missing error listener reports exactly once to console.error without unhandled rejection", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const { draw, popResolvers } = rawClaimedDrawWithDeferredScopes(gpu, "noListener");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);

  try {
    draw.draw({ target, offsets: { 1: [0] } });
    resolveRawClaimFailure(popResolvers, "no listener");
    await gpu.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toMatchObject({
      code: "VGPU-R4-GROUP-VALIDATION",
      where: "noListener.draw",
      detail: { drawLabel: "noListener", group: 1 },
    });
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    gpu.dispose();
  }
});

test("onError supports multiple listeners, unsubscribe order, and throwing listeners", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const { draw, popResolvers } = rawClaimedDrawWithDeferredScopes(gpu, "listeners");
  const listenerError = new Error("bad listener");
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const events: string[] = [];
  const unsubA = gpu.onError((error) => events.push(`a:${error.detail?.drawLabel}`));
  gpu.onError(() => { events.push("b:throw"); throw listenerError; });
  gpu.onError((error) => events.push(`c:${error.detail?.group}`));
  const unsubD = gpu.onError(() => events.push("d"));
  unsubD();

  draw.draw({ target, offsets: { 1: [0] } });
  unsubA();
  resolveRawClaimFailure(popResolvers, "listeners");
  await gpu.settled();

  expect(events).toEqual(["b:throw", "c:1"]);
  expect(consoleError).toHaveBeenCalledWith(listenerError);
  gpu.dispose();
});

test("gpu.settled snapshots pending validation deliveries", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const errors: string[] = [];
  gpu.onError((error) => errors.push(error.detail?.drawLabel ?? "unknown"));

  const first = rawClaimedDrawWithDeferredScopes(gpu, "firstSettled");
  first.draw.draw({ target, offsets: { 1: [0] } });
  const firstSettled = gpu.settled();

  const second = rawClaimedDrawWithDeferredScopes(gpu, "secondSettled");
  second.draw.draw({ target, offsets: { 1: [0] } });

  resolveRawClaimFailure(first.popResolvers, "first");
  await firstSettled;
  expect(errors).toEqual(["firstSettled"]);

  resolveRawClaimFailure(second.popResolvers, "second");
  await gpu.settled();
  expect(errors).toEqual(["firstSettled", "secondSettled"]);
  gpu.dispose();
});

test("sync pipeline creation throws are delivered once through gpu.onError", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const draw = gpu.draw({ shader: SIMPLE_SHADER, label: "syncThrow" });
  const nativeError = new Error("native createRenderPipeline failed");
  const errors: unknown[] = [];
  gpu.onError((error) => errors.push(error));
  vi.spyOn(gpu.device.gpu, "createRenderPipeline").mockImplementation(() => { throw nativeError; });

  expect(() => draw.draw(target)).not.toThrow();
  await gpu.settled();

  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    code: "VGPU-COMPILE-FAILED",
    where: "syncThrow.pipelineFor",
    cause: nativeError,
  });
  gpu.dispose();
});

test("Frame.done awaits queue.onSubmittedWorkDone even without claimed groups", async () => {
  const gpu = await init();
  const target = gpu.target({ size: [4, 4] });
  const effect = gpu.effect(SIMPLE_SHADER);
  let resolveSubmitted!: () => void;
  let submitted = false;
  vi.spyOn(gpu.device.gpu.queue, "onSubmittedWorkDone").mockImplementation(() => new Promise<void>((resolve) => {
    resolveSubmitted = () => { submitted = true; resolve(); };
  }));

  const frame = gpu.frame((f) => f.pass({ target }, (p) => p.draw(effect)));
  let done = false;
  void frame.done.then(() => { done = true; });
  await Promise.resolve();

  expect(done).toBe(false);
  expect(submitted).toBe(false);
  resolveSubmitted();
  await frame.done;
  expect(done).toBe(true);
  expect(submitted).toBe(true);
  gpu.dispose();
});

function resolveRawClaimFailure(popResolvers: ((error: GPUError | null) => void)[], message: string): void {
  expect(popResolvers.length).toBeGreaterThan(1);
  popResolvers[0]!(null);
  popResolvers[1]!({ message } as GPUError);
  for (const resolve of popResolvers.slice(2)) resolve(null);
}

function resolveRawAndFinalizeFailures(popResolvers: ((error: GPUError | null) => void)[], message: string): void {
  expect(popResolvers.length).toBeGreaterThan(1);
  popResolvers[0]!(null);
  for (const resolve of popResolvers.slice(1)) resolve({ message } as GPUError);
}

function rawClaimedDrawWithDeferredScopes(gpu: Awaited<ReturnType<typeof init>>, label: string) {
  const popResolvers: ((error: GPUError | null) => void)[] = [];
  const gpuDevice = gpu.device.gpu as GPUDevice & {
    pushErrorScope(filter: GPUErrorFilter): void;
    popErrorScope(): Promise<GPUError | null>;
  };
  gpuDevice.pushErrorScope = vi.fn();
  gpuDevice.popErrorScope = vi.fn(() => new Promise<GPUError | null>((resolve) => popResolvers.push(resolve)));

  const draw = gpu.draw({ shader: `${RAW_GROUP_SHADER}
// ${label}`, label, set: { globals: { tint: 1 } } });
  const rawBuffer = gpu.device.gpu.createBuffer({ size: 4, usage: 64 });
  const rawLayout = gpu.device.gpu.createBindGroupLayout({
    label: `${label}.raw-static-layout`,
    entries: [{ binding: 0, visibility: 2, buffer: { type: "uniform", hasDynamicOffset: false, minBindingSize: 4 } }],
  });
  const rawBindGroup = gpu.device.gpu.createBindGroup({
    label: `${label}.raw-static-bind-group`,
    layout: rawLayout,
    entries: [{ binding: 0, resource: { buffer: rawBuffer, offset: 0, size: 4 } }],
  });
  draw.layout(1, { dynamicOffsets: true });
  draw.group(1, rawBindGroup);
  return { draw, popResolvers };
}
