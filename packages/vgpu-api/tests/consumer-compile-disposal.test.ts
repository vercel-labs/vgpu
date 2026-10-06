import { compute, draw, effect, init, target } from "../src/mock.ts";
import { InternalDraw } from "../src/draw.ts";
import { expect, test, vi } from "vitest";

const DRAW_SHADER = `
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }
`;
const EFFECT_SHADER = "@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }";
const COMPUTE_SHADER = "@compute @workgroup_size(1) fn main() {}";

test("live invalid compute workgroups still reject compile() instead of throwing synchronously", async () => {
  const gpu = await init();
  try {
    Object.defineProperty(gpu.gpu.limits, "maxComputeWorkgroupSizeX", { value: 1 });
    const invalid = compute(gpu, "@compute @workgroup_size(2) fn main() {}", { label: "invalid-workgroup" });
    let pending: ReturnType<typeof invalid.compile> | undefined;

    expect(() => { pending = invalid.compile(); }).not.toThrow();
    await expect(pending).rejects.toMatchObject({
      code: "VGPU-COMPILE-FAILED",
      where: "invalid-workgroup.compile",
      cause: expect.objectContaining({ code: "VGPU-COMPUTE-WORKGROUP-INVALID" }),
    });
  } finally {
    gpu.dispose();
  }
});

test.each(["draw", "effect", "compute"] as const)("pending %s compile success rejects only its disposed owner", async kind => {
  const gpu = await init();
  try {
    const gate = deferred<GPURenderPipeline | GPUComputePipeline>();
    const native = kind === "compute"
      ? vi.spyOn(gpu.gpu, "createComputePipelineAsync").mockReturnValue(gate.promise as Promise<GPUComputePipeline>)
      : vi.spyOn(gpu.gpu, "createRenderPipelineAsync").mockReturnValue(gate.promise as Promise<GPURenderPipeline>);
    const [retired, peer] = compileOwners(kind, gpu);
    const retiredCompilation = retired.compile();
    const peerCompilation = peer.compile();

    retired.dispose();
    gate.resolve({} as GPURenderPipeline & GPUComputePipeline);

    await expect(retiredCompilation).rejects.toMatchObject({
      code: kind === "compute" ? "VGPU-COMPUTE-DISPOSED" : "VGPU-DRAW-DISPOSED",
      where: `${kind}-retired.compile`,
    });
    await expect(peerCompilation).resolves.toBe(peer.owner);
    expect(native).toHaveBeenCalledOnce();
  } finally {
    gpu.dispose();
  }
});

test.each(["draw", "effect", "compute"] as const)("pending %s compile failure gives the disposed owner precedence without poisoning retry", async kind => {
  const gpu = await init();
  const unhandled: unknown[] = [];
  const delivered: unknown[] = [];
  gpu.onError(error => delivered.push(error));
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const gate = deferred<GPURenderPipeline | GPUComputePipeline>();
    const native = kind === "compute"
      ? vi.spyOn(gpu.gpu, "createComputePipelineAsync").mockReturnValue(gate.promise as Promise<GPUComputePipeline>)
      : vi.spyOn(gpu.gpu, "createRenderPipelineAsync").mockReturnValue(gate.promise as Promise<GPURenderPipeline>);
    const [retired, peer] = compileOwners(kind, gpu);
    const retiredCompilation = retired.compile();
    const peerCompilation = peer.compile();
    const nativeFailure = new Error(`${kind} native failure`);
    const retiredRejection = expect(retiredCompilation).rejects.toMatchObject({
      code: kind === "compute" ? "VGPU-COMPUTE-DISPOSED" : "VGPU-DRAW-DISPOSED",
      where: `${kind}-retired.compile`,
    });
    const peerRejection = expect(peerCompilation).rejects.toMatchObject({ code: "VGPU-COMPILE-FAILED", cause: nativeFailure });

    retired.dispose();
    gate.reject(nativeFailure);

    await retiredRejection;
    await peerRejection;

    native.mockResolvedValue({} as never);
    await expect(peer.compile()).resolves.toBe(peer.owner);
    await gpu.settled();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    expect(delivered).toEqual([]);
    expect(native).toHaveBeenCalledTimes(2);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    gpu.dispose();
  }
});

test.each(["draw", "effect", "compute"] as const)("live %s sync takeover completes its peer while the disposed owner rejects", async kind => {
  const gpu = await init();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const gate = deferred<GPURenderPipeline | GPUComputePipeline>();
    const nativeAsync = kind === "compute"
      ? vi.spyOn(gpu.gpu, "createComputePipelineAsync").mockReturnValue(gate.promise as Promise<GPUComputePipeline>)
      : vi.spyOn(gpu.gpu, "createRenderPipelineAsync").mockReturnValue(gate.promise as Promise<GPURenderPipeline>);
    const nativeSync = kind === "compute"
      ? vi.spyOn(gpu.gpu, "createComputePipeline")
      : vi.spyOn(gpu.gpu, "createRenderPipeline");
    const [retired, peer] = compileOwners(kind, gpu);
    const retiredCompilation = retired.compile();
    const peerCompilation = peer.compile();
    const retiredRejection = expect(retiredCompilation).rejects.toMatchObject({
      code: kind === "compute" ? "VGPU-COMPUTE-DISPOSED" : "VGPU-DRAW-DISPOSED",
      where: `${kind}-retired.compile`,
    });

    retired.dispose();
    expect(peer.compileSync()).toBe(peer.owner);

    await retiredRejection;
    await expect(peerCompilation).resolves.toBe(peer.owner);
    gate.reject(new Error("superseded native failure"));
    await gpu.settled();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(nativeAsync).toHaveBeenCalledOnce();
    expect(nativeSync).toHaveBeenCalledOnce();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    gpu.dispose();
  }
});

test("Draw disposal wins when native success is waiting on validation scope settlement", async () => {
  const gpu = await init();
  try {
    const validation = deferred<GPUError | null>();
    Object.assign(gpu.gpu, {
      pushErrorScope: vi.fn(),
      popErrorScope: vi.fn(() => validation.promise),
    });
    const output = target(gpu, { size: [2, 2] });
    const drawable = draw(gpu, { shader: DRAW_SHADER, label: "validation-delayed" });
    const pending = drawable.compile(output);
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);

    drawable.dispose();
    validation.resolve(null);

    await expect(pending).rejects.toMatchObject({
      code: "VGPU-DRAW-DISPOSED",
      where: "validation-delayed.compile",
    });
  } finally {
    gpu.dispose();
  }
});

test.each(["draw", "effect", "compute"] as const)("pending live %s compile preserves GPU store teardown semantics", async kind => {
  const gpu = await init();
  const never = new Promise<GPURenderPipeline & GPUComputePipeline>(() => undefined);
  if (kind === "compute") vi.spyOn(gpu.gpu, "createComputePipelineAsync").mockReturnValue(never);
  else vi.spyOn(gpu.gpu, "createRenderPipelineAsync").mockReturnValue(never);
  const [owner] = compileOwners(kind, gpu);
  const pending = owner.compile();
  const rejection = expect(pending).rejects.toMatchObject({
    code: "VGPU-COMPILE-DISPOSED",
    where: "gpu.dispose",
  });

  gpu.dispose();

  await rejection;
});

test("disposed consumer wins when GPU teardown settles its pending compile", async () => {
  const gpu = await init();
  vi.spyOn(gpu.gpu, "createComputePipelineAsync").mockReturnValue(new Promise(() => undefined));
  const pipeline = compute(gpu, COMPUTE_SHADER, { label: "retired-before-gpu" });
  const pending = pipeline.compile();
  const rejection = expect(pending).rejects.toMatchObject({
    code: "VGPU-COMPUTE-DISPOSED",
    where: "retired-before-gpu.compile",
  });

  pipeline.dispose();
  gpu.dispose();

  await rejection;
});

test.each(["success", "failure"] as const)("internal Draw pipelineForAsync checks disposal after native %s", async outcome => {
  const gpu = await init();
  try {
    const gate = deferred<GPURenderPipeline>();
    vi.spyOn(gpu.gpu, "createRenderPipelineAsync").mockReturnValue(gate.promise);
    const output = target(gpu, { size: [2, 2] });
    const drawable = draw(gpu, { shader: DRAW_SHADER, label: `internal-${outcome}` }) as InternalDraw;
    const pending = drawable.pipelineForAsync(output);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "VGPU-DRAW-DISPOSED",
      where: `internal-${outcome}.pipelineForAsync`,
    });

    drawable.dispose();
    if (outcome === "success") gate.resolve({} as GPURenderPipeline);
    else gate.reject(new Error("internal native failure"));

    await rejection;
  } finally {
    gpu.dispose();
  }
});

type CompileOwner = {
  readonly owner: { dispose(): void };
  compile(): Promise<unknown>;
  compileSync(): unknown;
  dispose(): void;
};

function compileOwners(kind: "draw" | "effect" | "compute", gpu: Awaited<ReturnType<typeof init>>): readonly [CompileOwner, CompileOwner] {
  if (kind === "compute") {
    const retired = compute(gpu, COMPUTE_SHADER, { label: "compute-retired" });
    const peer = compute(gpu, COMPUTE_SHADER, { label: "compute-peer" });
    return [compileOwner(retired, () => retired.compile(), () => retired.compileSync()), compileOwner(peer, () => peer.compile(), () => peer.compileSync())];
  }
  const output = target(gpu, { size: [2, 2] });
  if (kind === "effect") {
    const retired = effect(gpu, EFFECT_SHADER, { label: "effect-retired" });
    const peer = effect(gpu, EFFECT_SHADER, { label: "effect-peer" });
    return [compileOwner(retired, () => retired.compile(output), () => retired.compileSync(output)), compileOwner(peer, () => peer.compile(output), () => peer.compileSync(output))];
  }
  const retired = draw(gpu, { shader: DRAW_SHADER, label: "draw-retired" });
  const peer = draw(gpu, { shader: DRAW_SHADER, label: "draw-peer" });
  return [compileOwner(retired, () => retired.compile(output), () => retired.compileSync(output)), compileOwner(peer, () => peer.compile(output), () => peer.compileSync(output))];
}

function compileOwner<T extends { dispose(): void }>(owner: T, compile: () => Promise<unknown>, compileSync: () => unknown): CompileOwner {
  return { owner, compile, compileSync, dispose: () => owner.dispose() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
