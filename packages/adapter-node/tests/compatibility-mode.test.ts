import { beforeEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  adapterOptions: [] as GPURequestAdapterOptions[],
  deviceLabels: [] as string[],
}));

vi.mock("node:module", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:module")>();
  return {
    ...original,
    createRequire: () => (id: string) => {
      if (id !== "webgpu") throw new Error(`Unexpected require: ${id}`);
      return {
        globals: {},
        create: () => ({
          async requestAdapter(options: GPURequestAdapterOptions): Promise<GPUAdapter> {
            state.adapterOptions.push(options);
            return {
              info: null,
              async requestDevice(): Promise<GPUDevice> {
                return {
                  set label(value: string) { state.deviceLabels.push(value); },
                  queue: { submit() {}, onSubmittedWorkDone: async () => undefined },
                  destroy() {},
                } as GPUDevice;
              },
            } as GPUAdapter;
          },
        } as GPU),
      };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  state.adapterOptions = [];
  state.deviceLabels = [];
});

test.runIf(process.platform === "linux")("node adapter marks default Linux Dawn devices as compatibility mode", async () => {
  const { createNodeDevice } = await import("../src/index.ts");

  const device = await createNodeDevice({ label: "compat-device" });

  expect(state.adapterOptions.at(-1)).toMatchObject({ featureLevel: "compatibility" });
  expect(device.isCompatibilityMode).toBe(true);
  expect(state.deviceLabels).toContain("compat-device");
});

test("node adapter leaves webgpu backend devices out of compatibility mode", async () => {
  const { createNodeDevice } = await import("../src/index.ts");

  const device = await createNodeDevice({ backend: "webgpu" });

  expect(state.adapterOptions.at(-1)).not.toHaveProperty("featureLevel");
  expect(device.isCompatibilityMode).toBe(false);
});
