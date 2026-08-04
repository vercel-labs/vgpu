import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { __resetValidationDeviceForTests, acquireValidationDevice, releaseValidationDevice, retainValidationDevice } from "../src/runtime/validation-device.ts";

/**
 * Exercises the real `validation-device.ts` (no mock of the module under test) with a stubbed
 * `@vgpu/adapter-node`, so the error translation — verbatim `fix` forwarding, `metadata.causeCode`,
 * preserved `cause` — is covered on machines without a GPU.
 */
const adapter = vi.hoisted(() => ({ thrown: undefined as unknown, device: undefined as unknown }));

vi.mock("@vgpu/adapter-node", () => ({
  createNodeAdapter: () => ({
    requestDevice: async () => {
      if (adapter.thrown !== undefined) throw adapter.thrown;
      return { gpu: adapter.device };
    },
  }),
}));

beforeEach(() => {
  __resetValidationDeviceForTests();
  adapter.thrown = undefined;
  adapter.device = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

test("forwards the adapter-node code, fix and cause on a device failure", async () => {
  const cause = { code: "VGPU-NODE-NO-ADAPTER", message: "No WebGPU adapter available with Dawn flags [].", fix: "To diagnose the environment, run: npx vgpu doctor" };
  adapter.thrown = cause;
  const error = await acquireValidationDevice().then(
    () => { throw new Error("expected a rejection"); },
    (rejection: unknown) => rejection as { code?: string; message?: string; fix?: string; where?: string; metadata?: Record<string, unknown>; cause?: unknown },
  );
  expect(error).toMatchObject({
    code: "VGPU-WGSL-VALIDATE-NO-DEVICE",
    fix: cause.fix,
    where: "resolveShader",
    metadata: { causeCode: "VGPU-NODE-NO-ADAPTER" },
  });
  expect(error.message).toContain("(VGPU-NODE-NO-ADAPTER)");
  expect(error.message).toContain("No WebGPU adapter available");
  expect(error.cause).toBe(cause);
});

test("degrades to a generic fix when the failure carries no code or fix", async () => {
  adapter.thrown = new Error("boom");
  await expect(acquireValidationDevice()).rejects.toMatchObject({
    code: "VGPU-WGSL-VALIDATE-NO-DEVICE",
    message: "device acquisition failed via @vgpu/adapter-node: boom",
    fix: "Run `npx vgpu doctor` to diagnose the local WebGPU/Dawn setup.",
  });
});

test("labels native stderr provenance when the failure exposes it", async () => {
  adapter.thrown = { code: "VGPU-NODE-NO-ADAPTER", message: "no adapter", fix: "run doctor", detail: { nativeStderr: "vkEnumeratePhysicalDevices failed" } };
  await expect(acquireValidationDevice()).rejects.toMatchObject({
    metadata: { causeCode: "VGPU-NODE-NO-ADAPTER", nativeStderr: "[dawn/vulkan] vkEnumeratePhysicalDevices failed" },
  });
});

test("memoizes the device so repeated validation shares one acquisition", async () => {
  const device = { label: "fake", destroy: vi.fn() };
  adapter.device = device;
  await expect(acquireValidationDevice()).resolves.toBe(device);
  adapter.device = { label: "second", destroy: vi.fn() };
  await expect(acquireValidationDevice()).resolves.toBe(device);
  expect(device.destroy).not.toHaveBeenCalled();
});

test("destroys the device once validation goes idle, so a script can exit on its own", async () => {
  vi.useFakeTimers();
  const first = { label: "first", destroy: vi.fn() };
  adapter.device = first;
  await acquireValidationDevice();
  releaseValidationDevice();
  expect(first.destroy).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(250);
  expect(first.destroy).toHaveBeenCalledTimes(1);

  // The next validation transparently acquires a fresh device.
  const second = { label: "second", destroy: vi.fn() };
  adapter.device = second;
  await expect(acquireValidationDevice()).resolves.toBe(second);
  releaseValidationDevice();
});

test("keeps the device alive while another validation still holds a lease", async () => {
  vi.useFakeTimers();
  const device = { label: "shared", destroy: vi.fn() };
  adapter.device = device;
  await acquireValidationDevice();
  await acquireValidationDevice();
  releaseValidationDevice();

  await vi.advanceTimersByTimeAsync(1_000);
  expect(device.destroy).not.toHaveBeenCalled();
  await expect(acquireValidationDevice()).resolves.toBe(device);
});

test("a retained lease keeps one device across a multi-step validation", async () => {
  // resolveShader validates twice under `identifiers: "safe"`. Without the outer retain, the idle
  // release fires in the gap between them and the second validation re-acquires a whole new device.
  vi.useFakeTimers();
  const device = { label: "retained", destroy: vi.fn() };
  adapter.device = device;
  retainValidationDevice();

  await acquireValidationDevice(); // first validateWGSL
  releaseValidationDevice();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(device.destroy).not.toHaveBeenCalled();

  await expect(acquireValidationDevice()).resolves.toBe(device); // second validateWGSL, same device
  releaseValidationDevice();
  releaseValidationDevice(); // resolveShader's own lease

  await vi.advanceTimersByTimeAsync(250);
  expect(device.destroy).toHaveBeenCalledTimes(1);
});

test("keeps a failed acquisition memoized instead of retrying it after idle", async () => {
  vi.useFakeTimers();
  adapter.thrown = new Error("boom");
  await expect(acquireValidationDevice()).rejects.toMatchObject({ code: "VGPU-WGSL-VALIDATE-NO-DEVICE" });
  releaseValidationDevice();
  await vi.advanceTimersByTimeAsync(1_000);

  adapter.device = { label: "would-succeed-now", destroy: vi.fn() };
  adapter.thrown = undefined;
  await expect(acquireValidationDevice()).rejects.toMatchObject({ code: "VGPU-WGSL-VALIDATE-NO-DEVICE" });
});
