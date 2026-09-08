import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { invokeTintWorker } from "../src/compiler/worker.ts";

const executable = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function inventoryRequest(): string {
  const text = "// worker transport probe\n";
  const virtualPath = "Intermediate/transport.wgsl";
  const sha256 = hash(text);
  // This literal is in canonical key order for the origin-map hash.
  const originMap = {
    contractId: "vgpu-native-origin-map/v1",
    generatedSource: { sha256, virtualPath },
    schemaVersion: 1,
    segments: [],
    sources: [{ input: "transport-wgsl", sha256 }],
  };
  return JSON.stringify({
    schemaVersion: 1,
    contractId: "vgpu-native-tint-entry-inventory/v1",
    source: { virtualPath, sha256, text },
    originMap,
    originMapSha256: hash(JSON.stringify(originMap)),
    languageFeatures: [],
  });
}

test("the pinned worker receives exact request bytes and returns a completed JSON response", async () => {
  const request = inventoryRequest();
  const result = await invokeTintWorker({ executable, request });
  expect(result).toMatchObject({
    ok: true,
    contractId: "vgpu-native-tint-entry-inventory/v1",
    requestIdentity: {
      domain: "vgpu-native-tint-entry-inventory-request-bytes/v1",
      sha256: hash(
        `vgpu-native-tint-entry-inventory-request-bytes/v1\0${request}`
      ),
    },
    result: { entryPoints: [] },
  });
});

test("a real compiler framing failure is rejected as a failed process, not consumed as a response", async () => {
  await expect(
    invokeTintWorker({ executable, request: "{" })
  ).rejects.toMatchObject({
    code: "process-failed",
    message: expect.stringContaining("65"),
  });
});

test("an invocation cancelled after starting does not return the worker response", async () => {
  const controller = new AbortController();
  const pending = invokeTintWorker({
    executable,
    request: inventoryRequest(),
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 25);
  try {
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  } finally {
    clearTimeout(timer);
  }
});

test("a compiler exceeding the requested bounded deadline is terminated", async () => {
  await expect(
    invokeTintWorker({ executable, request: inventoryRequest(), timeoutMs: 1 })
  ).rejects.toMatchObject({
    code: "timed-out",
  });
});

test("ambient dynamic-loader overrides cannot change the authenticated worker process", async () => {
  const previous = process.env.DYLD_PRINT_LIBRARIES;
  process.env.DYLD_PRINT_LIBRARIES = "1";
  try {
    await expect(
      invokeTintWorker({ executable, request: inventoryRequest() })
    ).resolves.toMatchObject({ ok: true });
  } finally {
    if (previous === undefined) delete process.env.DYLD_PRINT_LIBRARIES;
    else process.env.DYLD_PRINT_LIBRARIES = previous;
  }
});
