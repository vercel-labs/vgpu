import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { dawnCachePath, getCachedDawnBinary, installDawn, verifyDawnBinary } from "../src/dawn-installer";
import { glibcMismatch, resolveWebGPU } from "../src/dawn-loader";

const fixtureBytes = Buffer.from("mock portable Dawn binary");
const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
const temporaryDirectories: string[] = [];
const fakeModule = { create: vi.fn(), globals: {} };

function tempDir(): string {
  const path = mkdtempSync(`${tmpdir()}/vgpu-dawn-test-`);
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Dawn prebuild integrity", () => {
  test("accepts the expected hash and refuses a hash mismatch", () => {
    const path = `${tempDir()}/dawn.node`;
    writeFileSync(path, fixtureBytes);
    expect(() => verifyDawnBinary(path, fixtureSha256)).not.toThrow();
    expect(() => verifyDawnBinary(path)).toThrowError(expect.objectContaining({ code: "VGPU-NODE-PREBUILD-CHECKSUM" }));
  });

  test("downloads through a mocked network and reuses the per-version cache", async () => {
    const cacheRoot = tempDir();
    const fetch = vi.fn(async () => new Response(fixtureBytes, { status: 200 }));
    const first = await installDawn({ cacheRoot, platform: "linux", arch: "arm64", env: {}, fetch, expectedSha256: fixtureSha256 });
    expect(first.downloaded).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(getCachedDawnBinary({ cacheRoot, expectedSha256: fixtureSha256 })).toBe(first.path);
    const second = await installDawn({ cacheRoot, platform: "linux", arch: "arm64", env: {}, fetch, expectedSha256: fixtureSha256 });
    expect(second).toEqual({ path: first.path, downloaded: false });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("Dawn resolution order", () => {
  test("VGPU_DAWN_BINARY wins over cache and stock webgpu", async () => {
    const calls: string[] = [];
    const envPath = resolve(tempDir(), "custom.node");
    const loaded = await resolveWebGPU({
      env: { VGPU_DAWN_BINARY: envPath },
      require: ((id: string) => {
        calls.push(id);
        return fakeModule;
      }) as NodeJS.Require,
    });
    expect(loaded).toBe(fakeModule);
    expect(calls).toEqual([envPath]);
  });

  test("verified cache wins over stock webgpu", async () => {
    const cacheRoot = tempDir();
    const cached = dawnCachePath({ cacheRoot });
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, fixtureBytes);
    const calls: string[] = [];
    await resolveWebGPU({
      cacheRoot,
      expectedSha256: fixtureSha256,
      platform: "linux",
      arch: "arm64",
      env: {},
      require: ((id: string) => {
        calls.push(id);
        return fakeModule;
      }) as NodeJS.Require,
    });
    expect(calls).toEqual([cached]);
  });

  test("uses stock webgpu before attempting a lazy download", async () => {
    const fetch = vi.fn();
    const calls: string[] = [];
    await resolveWebGPU({
      cacheRoot: tempDir(),
      platform: "linux",
      arch: "arm64",
      env: {},
      fetch,
      require: ((id: string) => {
        calls.push(id);
        return fakeModule;
      }) as NodeJS.Require,
    });
    expect(calls).toEqual(["webgpu"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Dawn error taxonomy", () => {
  test("names required and detected glibc versions", () => {
    expect(glibcMismatch(new Error("libc.so.6: version `GLIBC_2.38' not found"), "2.36")).toEqual({ required: "2.38", host: "2.36" });
  });

  test("reports musl explicitly without touching the network", async () => {
    const fetch = vi.fn();
    await expect(installDawn({ cacheRoot: tempDir(), platform: "linux", arch: "arm64", libc: "musl", env: {}, fetch })).rejects.toMatchObject({
      code: "VGPU-NODE-PREBUILD-MISSING",
      message: expect.stringContaining("musl libc is unsupported"),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("reports unsupported platform when stock and prebuild are unavailable", async () => {
    await expect(
      resolveWebGPU({
        cacheRoot: tempDir(),
        platform: "darwin",
        arch: "arm64",
        env: {},
        require: (() => {
          throw new Error("stock missing");
        }) as unknown as NodeJS.Require,
      }),
    ).rejects.toMatchObject({ code: "VGPU-NODE-PREBUILD-MISSING", message: expect.stringContaining("unsupported platform darwin/arm64") });
  });

  test("reports offline download failure with manual install guidance", async () => {
    await expect(
      resolveWebGPU({
        cacheRoot: tempDir(),
        platform: "linux",
        arch: "arm64",
        env: {},
        fetch: vi.fn(async () => {
          throw new Error("fetch failed: ENETUNREACH");
        }),
        require: (() => {
          throw new Error("libc.so.6: version `GLIBC_2.38' not found");
        }) as unknown as NodeJS.Require,
      }),
    ).rejects.toMatchObject({
      code: "VGPU-NODE-PREBUILD-MISSING",
      message: expect.stringMatching(/GLIBC 2\.38.*offline/u),
      fix: expect.stringContaining("vgpu install-dawn"),
    });
  });
});
