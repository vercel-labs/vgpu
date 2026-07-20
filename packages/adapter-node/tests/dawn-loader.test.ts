import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

  test("concurrent downloads use independent temporary files and converge", async () => {
    const cacheRoot = tempDir();
    const fetch = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(fixtureBytes, { status: 200 });
    });
    const options = { cacheRoot, platform: "linux" as const, arch: "arm64", libc: "glibc" as const, env: {}, fetch, expectedSha256: fixtureSha256 };
    const [first, second] = await Promise.all([installDawn(options), installDawn(options)]);
    expect(first.path).toBe(second.path);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(() => verifyDawnBinary(first.path, fixtureSha256)).not.toThrow();
  });

  test("rejects a symlinked cache entry", async () => {
    const cacheRoot = tempDir();
    const target = `${tempDir()}/fixture.node`;
    writeFileSync(target, fixtureBytes);
    const cached = dawnCachePath({ cacheRoot });
    mkdirSync(dirname(cached), { recursive: true });
    symlinkSync(target, cached);
    expect(() => getCachedDawnBinary({ cacheRoot, expectedSha256: fixtureSha256 })).toThrowError(
      expect.objectContaining({ code: "VGPU-NODE-PREBUILD-CHECKSUM" }),
    );
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
        writeFileSync(id, "replacement inside private load directory");
        return fakeModule;
      }) as NodeJS.Require,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toBe(cached);
    expect(readFileSync(cached)).toEqual(fixtureBytes);
  });

  test("never loads a Linux cache when platform eligibility fails", async () => {
    const cacheRoot = tempDir();
    const cached = dawnCachePath({ cacheRoot });
    mkdirSync(dirname(cached), { recursive: true });
    writeFileSync(cached, fixtureBytes);
    const calls: string[] = [];
    await resolveWebGPU({
      cacheRoot,
      expectedSha256: fixtureSha256,
      platform: "linux",
      arch: "x64",
      libc: "glibc",
      env: {},
      require: ((id: string) => {
        calls.push(id);
        return fakeModule;
      }) as NodeJS.Require,
    });
    expect(calls).toEqual(["webgpu"]);
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

  test("bounds requests even when fetch ignores AbortSignal", async () => {
    await expect(
      installDawn({
        cacheRoot: tempDir(),
        platform: "linux",
        arch: "arm64",
        libc: "glibc",
        env: {},
        requestTimeoutMs: 10,
        overallTimeoutMs: 20,
        fetch: vi.fn(() => new Promise<Response>(() => {})),
      }),
    ).rejects.toMatchObject({ code: "VGPU-NODE-PREBUILD-MISSING", message: expect.stringContaining("timed out") });
  });

  test("bounds authenticated release metadata bodies", async () => {
    const response = {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => new Promise<unknown>(() => {}),
    } as Response;
    await expect(
      installDawn({
        cacheRoot: tempDir(),
        platform: "linux",
        arch: "arm64",
        libc: "glibc",
        env: { GH_TOKEN: "test" },
        requestTimeoutMs: 10,
        overallTimeoutMs: 20,
        fetch: vi.fn(async () => response),
      }),
    ).rejects.toMatchObject({ code: "VGPU-NODE-PREBUILD-MISSING", message: expect.stringContaining("timed out") });
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
