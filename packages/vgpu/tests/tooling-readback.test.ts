import { beforeEach, expect, test, vi } from "vitest";
import { renderRepresentativeSnapshot } from "../lib/snapshot/render.js";
import { runDoctor } from "../lib/doctor/run.js";

const state = vi.hoisted(() => ({
  pixels: new Uint8Array(16 * 16 * 4),
  read: vi.fn(), dispose: vi.fn(), draw: vi.fn(), set: vi.fn(),
}));

vi.mock("vgpu/node", () => ({
  init: async () => ({ device: { adapterInfo: { description: "test CPU", adapterType: "cpu" } }, dispose: state.dispose }),
  // Deliberately no Target.read: tooling must select the color attachment.
  target: () => ({ color: { read: state.read } }),
  effect: () => ({ set: state.set }),
  frame: (_gpu: unknown, callback: (f: unknown) => void) => callback({
    pass: (_options: unknown, encode: (p: unknown) => void) => encode({ draw: state.draw }),
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.read.mockResolvedValue(state.pixels);
});

test("snapshot CLI reads the selected attachment with explicit mip and region", async () => {
  const api = await import("vgpu/node");
  expect((await renderRepresentativeSnapshot(api)).pixels).toBe(state.pixels);
  expect(state.read).toHaveBeenCalledExactlyOnceWith({ mipLevel: 0, region: "all" });
  expect(state.draw).toHaveBeenCalledOnce();
  expect(state.dispose).toHaveBeenCalledOnce();
});

test("doctor's real render path uses attachment readback and releases its device", async () => {
  const result = await runDoctor([], {
    platform: "linux", arch: "arm64", env: {}, osRelease: { ID: "debian" }, glibc: "2.41",
    exists: () => true, listIcds: () => ["/test/lvp_icd.json"], command: () => null,
    softwareRenderer: async () => ({ path: null }),
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout!)).toMatchObject({ verdict: "healthy" });
  expect(state.read).toHaveBeenCalledExactlyOnceWith({ mipLevel: 0, region: "all" });
  expect(state.dispose).toHaveBeenCalledOnce();
});

test("snapshot CLI releases its device if attachment readback fails", async () => {
  state.read.mockRejectedValueOnce(new Error("readback failed"));
  await expect(renderRepresentativeSnapshot(await import("vgpu/node"))).rejects.toThrow("readback failed");
  expect(state.dispose).toHaveBeenCalledOnce();
});
