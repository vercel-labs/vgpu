import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import {
  mkdtemp,
  readFile,
  rm,
  lstat,
  writeFile,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { downloadVerifiedAsset } from "./lib/verified-asset.mjs";

test("the maintainer CLI derives its URL and destination from the lock and refuses overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "vgpu-worker-cli-"));
  const bytes = Buffer.from("accepted compiler fixture");
  const expected = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const source = join(root, "tooling/native-tint-worker/c1-tint-direct-build");
  const script = join(root, "scripts/fetch-native-worker.mjs");
  const preload = join(root, "transport.mjs");
  const destination = join(source, ".artifacts/bin/vgpu-tint-worker-universal");
  try {
    await mkdir(join(root, "scripts/lib"), { recursive: true });
    await mkdir(join(source, "provenance"), { recursive: true });
    await copyFile(
      new URL("./fetch-native-worker.mjs", import.meta.url),
      script
    );
    await copyFile(
      new URL("./lib/verified-asset.mjs", import.meta.url),
      join(root, "scripts/lib/verified-asset.mjs")
    );
    await writeFile(
      join(source, "provenance/source-lock.json"),
      JSON.stringify({ build: { outputs: { universal: expected } } })
    );
    // Mock only the network boundary in the child; execute the real command and filesystem path.
    await writeFile(
      preload,
      `globalThis.fetch = async (url) => { console.log("REQUEST " + url); return new Response("accepted compiler fixture"); };`
    );
    const run = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        ["--import", pathToFileURL(preload).href, script, ...args],
        { cwd: root }
      );
    await expect(
      run("--url=https://example.invalid/untrusted")
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("no overrides"),
    });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await run();
    expect(result.stdout).toContain(
      `REQUEST https://github.com/vercel-labs/vgpu/releases/download/native-tint-${expected.sha256}/vgpu-tint-worker-universal`
    );
    expect(await readFile(destination)).toEqual(bytes);
    await expect(run()).rejects.toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("destination already exists"),
    });
    expect(await readFile(destination)).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("downloads the exact authenticated asset into a fresh file", async () => {
  const root = await mkdtemp(join(tmpdir(), "vgpu-worker-download-"));
  const bytes = Buffer.from("accepted compiler fixture");
  const destination = join(root, "worker");
  try {
    await downloadVerifiedAsset({
      url: "https://example.invalid/worker",
      destination,
      expected: {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      fetch: async () => new Response(bytes),
    });
    expect(await readFile(destination)).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["truncated", "tampered"])(
  "rejects a %s asset before writing",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "vgpu-worker-download-"));
    const destination = join(root, "worker");
    const accepted = Buffer.from("accepted");
    try {
      await expect(
        downloadVerifiedAsset({
          url: "https://example.invalid/worker",
          destination,
          expected: {
            bytes: accepted.length,
            sha256: createHash("sha256").update(accepted).digest("hex"),
          },
          fetch: async () =>
            new Response(kind === "truncated" ? "accept" : "tampered"),
        })
      ).rejects.toThrow("does not match");
      await expect(lstat(destination)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test("never replaces a pre-existing asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "vgpu-worker-download-"));
  const destination = join(root, "worker");
  const bytes = Buffer.from("accepted");
  try {
    await writeFile(destination, "preserve me");
    await expect(
      downloadVerifiedAsset({
        url: "https://example.invalid/worker",
        destination,
        expected: {
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        fetch: async () => new Response(bytes),
      })
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(destination, "utf8")).toBe("preserve me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stops an oversized response without draining it or writing output", async () => {
  const root = await mkdtemp(join(tmpdir(), "vgpu-worker-download-"));
  let cancelled = false;
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(32));
      if (pulls === 10) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const destination = join(root, "worker");
  try {
    await expect(
      downloadVerifiedAsset({
        url: "https://example.invalid/worker",
        destination,
        expected: { bytes: 16, sha256: "0".repeat(64) },
        fetch: async () => new Response(body),
      })
    ).rejects.toThrow("exceeds locked size");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects HTTP failure even if its body matches the accepted bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "vgpu-worker-download-"));
  const bytes = Buffer.from("accepted compiler fixture");
  const destination = join(root, "worker");
  try {
    await expect(
      downloadVerifiedAsset({
        url: "https://example.invalid/worker",
        destination,
        expected: {
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
        fetch: async () => new Response(bytes, { status: 404 }),
      })
    ).rejects.toThrow("HTTP 404");
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
