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
  vendorIcds: [] as string[],
}));

// The vendor-driver probe reads the host's real ICD directory; mock it so the notice wording
// under test never depends on whether the machine running the suite has a Vulkan driver.
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readdirSync: ((path: Parameters<typeof original.readdirSync>[0], ...rest: unknown[]) =>
      String(path) === "/usr/share/vulkan/icd.d" ? state.vendorIcds : (original.readdirSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof original.readdirSync,
  };
});

vi.mock("../src/software-renderer-cache.ts", () => ({
  getCachedSoftwareRenderer: () => state.cachedIcd,
  createPrivateSoftwareRendererCopy: (path: string) => ({ path, cleanup() {} }),
}));

vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: () => (id: string) => {
      // The verified loader requires a private temporary copy of the cached native binary;
      // direct package mode still requires the package name.
      if (id !== "webgpu" && !id.endsWith(".node")) throw new Error(`Unexpected require: ${id}`);
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
                features: new Set(["timestamp-query"]),
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
  state.vendorIcds = [];
  delete process.env.VK_ICD_FILENAMES;
  delete process.env.VK_DRIVER_FILES;
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

test("node adapter fails clearly when a required feature is unsupported", async () => {
  const { createNodeDevice } = await import("../src/index.ts");
  await expect(createNodeDevice({ requiredFeatures: ["depth-clip-control"] })).rejects.toMatchObject({
    code: "VGPU-FEATURE-UNSUPPORTED",
    message: expect.stringContaining('"depth-clip-control"'),
  });
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
  // No vendor ICD is configured (env cleared, icd.d stubbed empty), so the notice blames the absent adapter.
  expect(error).toHaveBeenCalledWith(expect.stringContaining("no GPU adapter was found"));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("using CPU software renderer (lavapipe)"));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("XDG_RUNTIME_DIR"));
  device.destroy();
  error.mockRestore();
});

test("the software renderer notice blames the vendor driver when a Vulkan ICD is configured", async () => {
  state.nullRequestsRemaining = 3;
  state.cachedIcd = "/cache/lvp_icd.json";
  // VK_ICD_FILENAMES is the first branch of the vendor probe, so this holds on any host.
  process.env.VK_ICD_FILENAMES = "/usr/share/vulkan/icd.d/radeon_icd.json";
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { createNodeAdapter } = await import("../src/index.ts");
    const device = await createNodeAdapter({ adapter: "auto" }).requestDevice({ adapterRequestRetryBaseDelayMs: 0 } as never);
    expect(state.icdAtRequest.at(-1)).toBe("/cache/lvp_icd.json");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("a vendor Vulkan driver is present but failed to initialize"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("using CPU software renderer (lavapipe)"));
    device.destroy();
  } finally {
    delete process.env.VK_ICD_FILENAMES;
    error.mockRestore();
  }
});

test("auto explains a directly discovered CPU adapter once per process", async () => {
  state.adapterInfo = { description: "llvmpipe (LLVM 19.1.7, 128 bits)" } as unknown as GPUAdapterInfo;
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { createNodeDevice } = await import("../src/index.ts");
  const first = await createNodeDevice({ adapterRequestRetryBaseDelayMs: 0 } as never);
  const second = await createNodeDevice({ adapterRequestRetryBaseDelayMs: 0 } as never);
  expect(error).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("using CPU software renderer (llvmpipe (LLVM 19.1.7, 128 bits))"));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("no hardware GPU adapter is available"));
  first.destroy();
  second.destroy();
  error.mockRestore();
});

test("auto stays quiet when a hardware adapter is discovered", async () => {
  state.adapterInfo = { description: "NVIDIA GeForce RTX 4090", vendor: "nvidia" } as unknown as GPUAdapterInfo;
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { createNodeDevice } = await import("../src/index.ts");
  const device = await createNodeDevice({ adapterRequestRetryBaseDelayMs: 0 } as never);
  expect(error).not.toHaveBeenCalled();
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
