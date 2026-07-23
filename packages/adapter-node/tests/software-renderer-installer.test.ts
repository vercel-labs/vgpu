import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import { installSoftwareRenderer, softwareRendererCacheDirectory } from "../src/software-renderer-installer.ts";

const directories: string[] = [];
function cacheRoot(): string { const path = mkdtempSync(`${tmpdir()}/vgpu-software-renderer-test-`); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("portable software renderer installer", () => {
  test("rejects unsupported platforms without touching the network", async () => {
    const fetch = vi.fn();
    await expect(installSoftwareRenderer({ platform: "darwin", arch: "arm64", fetch })).rejects.toMatchObject({
      code: "VGPU-NODE-SOFTWARE-RENDERER-UNSUPPORTED",
      message: expect.stringContaining("darwin/arm64"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects a downloaded archive whose sha256 does not match", async () => {
    const fetch = vi.fn(async () => new Response("not the pinned archive", { status: 200 }));
    await expect(installSoftwareRenderer({ cacheRoot: cacheRoot(), platform: "linux", arch: "x64", fetch })).rejects.toMatchObject({
      code: "VGPU-NODE-SOFTWARE-RENDERER-CHECKSUM",
      message: expect.stringContaining("does not match pinned"),
    });
  });

  test("uses a versioned cache beside the Dawn cache root", () => {
    expect(softwareRendererCacheDirectory({ cacheRoot: "/cache", arch: "x64" })).toBe("/cache/vgpu/software-renderer/25.0.7-vgpu.1/linux-x64");
  });
});
