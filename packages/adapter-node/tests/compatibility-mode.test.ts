import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  adapterOptions: [] as GPURequestAdapterOptions[],
  createFlags: [] as string[][],
  nullRequestsRemaining: 0,
  deviceLabels: [] as string[],
  deviceDescriptors: [] as GPUDeviceDescriptor[],
  cachedIcd: null as string | null,
  adapterInfo: null as GPUAdapterInfo | null,
  icdAtRequest: [] as (string | undefined)[],
}));

vi.mock("../src/software-renderer-cache.ts", () => ({
  getCachedSoftwareRenderer: () => state.cachedIcd,
  createPrivateSoftwareRendererCopy: (path: string) => ({ path, cleanup() {} }),
}));

vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: () => (id: string) => {
      if (id !== "webgpu") throw new Error(`Unexpected require: ${id}`);
      return {
        globals: {},
        create: (flags: string[]) => {
          state.createFlags.push(flags);
          return {
            async requestAdapter(options: GPURequestAdapterOptions): Promise<GPUAdapter | null> {
              state.adapterOptions.push(options);
              state.icdAtRequest.push(process.env.VK_ICD_FILENAMES);
              if (state.nullRequestsRemaining > 0) {
                state.nullRequestsRemaining--;
                return null;
              }
              return {
                info: state.adapterInfo,
                async requestDevice(descriptor: GPUDeviceDescriptor): Promise<GPUDevice> {
                  state.deviceDescriptors.push(descriptor);
                  return {
                    set label(value: string) { state.deviceLabels.push(value); },
                    queue: { submit() {}, onSubmittedWorkDone: async () => undefined },
                    destroy() {},
                  } as GPUDevice;
                },
              } as GPUAdapter;
            },
          } as GPU;
        },
      };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  state.adapterOptions = [];
  state.createFlags = [];
  state.nullRequestsRemaining = 0;
  state.deviceLabels = [];
  state.deviceDescriptors = [];
  state.cachedIcd = null;
  state.adapterInfo = null;
  state.icdAtRequest = [];
});

test.runIf(process.platform === "linux")("node adapter marks default Linux Dawn devices as compatibility mode", async () => {
  const { createNodeDevice } = await import("../src/index.ts");

  const device = await createNodeDevice({ label: "compat-device" });

  expect(state.adapterOptions.at(-1)).toMatchObject({ featureLevel: "compatibility" });
  expect(device.isCompatibilityMode).toBe(true);
  expect(state.deviceLabels).toContain("compat-device");
});

test("node adapter forwards required features and limits to requestDevice", async () => {
  const { createNodeDevice } = await import("../src/index.ts");
  const requiredFeatures = ["timestamp-query"] as const;
  const requiredLimits = { maxStorageBuffersInVertexStage: 2 };
  await createNodeDevice({ requiredFeatures, requiredLimits });
  expect(state.deviceDescriptors.at(-1)).toEqual({ requiredFeatures, requiredLimits });
});

test("node adapter leaves webgpu backend devices out of compatibility mode", async () => {
  const { createNodeDevice } = await import("../src/index.ts");

  const device = await createNodeDevice({ backend: "webgpu" });

  expect(state.adapterOptions.at(-1)).not.toHaveProperty("featureLevel");
  expect(device.isCompatibilityMode).toBe(false);
});

test.runIf(process.platform === "linux")("node adapter lets Dawn discover Vulkan when no display server is configured", async () => {
  const display = process.env.DISPLAY;
  const waylandDisplay = process.env.WAYLAND_DISPLAY;
  delete process.env.DISPLAY;
  delete process.env.WAYLAND_DISPLAY;
  try {
    const { createNodeDevice } = await import("../src/index.ts");
    const device = await createNodeDevice();
    expect(state.createFlags).toEqual([[]]);
    device.destroy();
  } finally {
    if (display !== undefined) process.env.DISPLAY = display;
    if (waylandDisplay !== undefined) process.env.WAYLAND_DISPLAY = waylandDisplay;
  }
});

test.runIf(process.platform === "linux")("node adapter preserves the OpenGL default when a display server is configured", async () => {
  const display = process.env.DISPLAY;
  process.env.DISPLAY = ":99";
  try {
    const { createNodeDevice } = await import("../src/index.ts");
    const device = await createNodeDevice();
    expect(state.createFlags).toEqual([["backend=opengl"]]);
    device.destroy();
  } finally {
    if (display === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = display;
  }
});

test("node adapter preserves explicit OpenGL backend selection", async () => {
  const { createNodeDevice } = await import("../src/index.ts");
  const device = await createNodeDevice({ backend: "opengl" });
  expect(state.createFlags).toEqual([["backend=opengl"]]);
  device.destroy();
});

test("node adapter reports structured diagnostics after identical adapter retries", async () => {
  state.nullRequestsRemaining = 3;
  const { createNodeDevice } = await import("../src/index.ts");
  const error = await createNodeDevice({ adapterRequestRetryBaseDelayMs: 0 }).catch((cause: unknown) => cause) as Error & { code?: string; where?: string; fix?: string };
  expect(state.adapterOptions).toHaveLength(3);
  expect(state.adapterOptions).toEqual([
    { powerPreference: undefined, featureLevel: "compatibility" },
    { powerPreference: undefined, featureLevel: "compatibility" },
    { powerPreference: undefined, featureLevel: "compatibility" },
  ]);
  expect(error).toMatchObject({ name: "VGPUError", code: "VGPU-NODE-NO-ADAPTER", where: "createNodeAdapter" });
  expect(error.message).toContain("Dawn flags [");
  expect(error.fix).toContain("VK_ICD_FILENAMES");
});

test("auto retries with the cached software renderer only after hardware discovery returns no adapter", async () => {
  state.nullRequestsRemaining = 3;
  state.cachedIcd = "/cache/lvp_icd.json";
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { createNodeAdapter } = await import("../src/index.ts");
  const device = await createNodeAdapter({ adapter: "auto" }).requestDevice({ adapterRequestRetryBaseDelayMs: 0 } as never);
  expect(state.icdAtRequest).toEqual([undefined, undefined, undefined, "/cache/lvp_icd.json"]);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("using CPU software renderer (lavapipe)"));
  device.destroy();
  error.mockRestore();
});

test("software mode requires the cache, forces its ICD from the first request, and stays quiet", async () => {
  state.cachedIcd = "/cache/lvp_icd.json";
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { createNodeAdapter } = await import("../src/index.ts");
  const device = await createNodeAdapter({ adapter: "software" }).requestDevice({ adapterRequestRetryBaseDelayMs: 0 } as never);
  expect(state.icdAtRequest).toEqual(["/cache/lvp_icd.json"]);
  expect(error).not.toHaveBeenCalled();
  expect((device.adapterInfo as GPUAdapterInfo & { adapterType?: string }).adapterType).toBe("cpu");
  device.destroy();
  error.mockRestore();
});

test("hardware mode rejects a discovered CPU adapter and never consults the portable cache", async () => {
  state.cachedIcd = "/cache/lvp_icd.json";
  state.adapterInfo = { description: "llvmpipe" } as unknown as GPUAdapterInfo;
  const { createNodeAdapter } = await import("../src/index.ts");
  await expect(createNodeAdapter({ adapter: "hardware" }).requestDevice({ adapterRequestRetryBaseDelayMs: 0 } as never)).rejects.toMatchObject({
    code: "VGPU-NODE-NO-ADAPTER",
    fix: expect.stringContaining("real GPU"),
  });
  expect(state.icdAtRequest).toEqual([undefined]);
});

test("VGPU_ADAPTER accepts hardware/software, announces the override, and rejects invalid values", async () => {
  const previous = process.env.VGPU_ADAPTER;
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { nodeAdapterEnvironmentOverride } = await import("../src/index.ts");
  try {
    process.env.VGPU_ADAPTER = "hardware";
    expect(nodeAdapterEnvironmentOverride()).toBe("hardware");
    expect(error).toHaveBeenCalledWith("vgpu: adapter overridden by VGPU_ADAPTER=hardware");
    process.env.VGPU_ADAPTER = "invalid";
    expect(() => nodeAdapterEnvironmentOverride()).toThrowError(expect.objectContaining({ code: "VGPU-NODE-ADAPTER-INVALID" }));
  } finally {
    if (previous === undefined) delete process.env.VGPU_ADAPTER;
    else process.env.VGPU_ADAPTER = previous;
    error.mockRestore();
  }
});
