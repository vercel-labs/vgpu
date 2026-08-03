import { beforeEach, expect, test, vi } from "vitest";
import { __resetValidationDeviceForTests, acquireValidationDevice } from "../src/runtime/validation-device.ts";

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
  const device = { label: "fake" };
  adapter.device = device;
  await expect(acquireValidationDevice()).resolves.toBe(device);
  adapter.device = { label: "second" };
  await expect(acquireValidationDevice()).resolves.toBe(device);
});
