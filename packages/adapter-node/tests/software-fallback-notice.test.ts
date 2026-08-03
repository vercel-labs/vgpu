import { describe, expect, test } from "vitest";
import { formatSoftwareFallbackNotice, isSoftwareAdapter, softwareAdapterName } from "../src/software-fallback-notice.ts";

const info = (fields: Record<string, string>): GPUAdapterInfo => fields as unknown as GPUAdapterInfo;

describe("isSoftwareAdapter", () => {
  test("detects CPU renderers by name across the info fields", () => {
    expect(isSoftwareAdapter(info({ description: "llvmpipe (LLVM 19.1.7, 128 bits)" }))).toBe(true);
    expect(isSoftwareAdapter(info({ device: "lavapipe" }))).toBe(true);
    expect(isSoftwareAdapter(info({ vendor: "Google SwiftShader" }))).toBe(true);
    expect(isSoftwareAdapter(info({ description: "Software Rasterizer" }))).toBe(true);
  });

  test("detects CPU renderers by adapter type", () => {
    expect(isSoftwareAdapter(info({ description: "Some Renderer", adapterType: "cpu" }))).toBe(true);
    expect(isSoftwareAdapter(info({ description: "Some Renderer", type: "cpu" }))).toBe(true);
  });

  test("leaves hardware adapters and missing info alone", () => {
    expect(isSoftwareAdapter(info({ description: "Apple M3 Pro", vendor: "apple", adapterType: "integrated-gpu" }))).toBe(false);
    expect(isSoftwareAdapter(info({ description: "NVIDIA GeForce RTX 4090", vendor: "nvidia" }))).toBe(false);
    expect(isSoftwareAdapter(null)).toBe(false);
    expect(isSoftwareAdapter(undefined)).toBe(false);
  });
});

describe("softwareAdapterName", () => {
  test("prefers description, then device, then vendor", () => {
    expect(softwareAdapterName(info({ description: "llvmpipe (LLVM 19.1.7, 128 bits)", device: "lavapipe", vendor: "mesa" }))).toBe("llvmpipe (LLVM 19.1.7, 128 bits)");
    expect(softwareAdapterName(info({ device: "lavapipe", vendor: "mesa" }))).toBe("lavapipe");
    expect(softwareAdapterName(info({ vendor: "mesa" }))).toBe("mesa");
  });

  test("falls back to lavapipe when the adapter reports nothing", () => {
    expect(softwareAdapterName(info({}))).toBe("lavapipe");
    expect(softwareAdapterName(null)).toBe("lavapipe");
  });
});

describe("formatSoftwareFallbackNotice", () => {
  test("names the cause, the renderer, and marks the native warnings as harmless", () => {
    const notice = formatSoftwareFallbackNotice({ adapter: "llvmpipe", reason: "vendor-driver-failed" });
    const [headline, explanation] = notice.split("\n");
    expect(headline).toContain("a vendor Vulkan driver is present but failed to initialize");
    expect(headline).toContain("using CPU software renderer (llvmpipe)");
    expect(headline).toContain("rendering continues normally");
    expect(explanation).toContain("XDG_RUNTIME_DIR");
    expect(explanation).toContain("harmless");
    expect(explanation).toContain("npx vgpu doctor");
  });

  test("every line is prefixed so the notice is attributable to vgpu", () => {
    for (const reason of ["vendor-driver-failed", "no-adapter", "cpu-adapter-selected"] as const) {
      for (const line of formatSoftwareFallbackNotice({ adapter: "lavapipe", reason }).split("\n")) expect(line.startsWith("vgpu: notice — ")).toBe(true);
    }
  });

  test("reads as expected behaviour rather than a crash for each cause", () => {
    expect(formatSoftwareFallbackNotice({ adapter: "lavapipe", reason: "no-adapter" })).toContain("no GPU adapter was found");
    expect(formatSoftwareFallbackNotice({ adapter: "llvmpipe", reason: "cpu-adapter-selected" })).toContain("no hardware GPU adapter is available");
    for (const reason of ["vendor-driver-failed", "no-adapter", "cpu-adapter-selected"] as const) {
      expect(formatSoftwareFallbackNotice({ adapter: "lavapipe", reason })).toContain("This is expected on a machine without a usable GPU");
    }
  });
});
