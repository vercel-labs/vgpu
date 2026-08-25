import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { readMutableArtifact, readRevisionArtifact } from "./artifact-store";
import { DISCOVERY_ARTIFACT_KEY } from "./route-config";

const { blobGet } = vi.hoisted(() => ({ blobGet: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: blobGet }));

async function withLocalArtifact(key: string, content: string, run: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "vgpu-artifact-abort-"));
  const previousRoot = process.env.VGPU_EXAMPLES_LOCAL_ROOT;
  const previousStore = process.env.VGPU_EXAMPLES_ARTIFACT_STORE;
  try {
    process.env.VGPU_EXAMPLES_LOCAL_ROOT = root;
    process.env.VGPU_EXAMPLES_ARTIFACT_STORE = "local";
    const path = join(root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    await run();
  } finally {
    restoreEnvironmentVariable("VGPU_EXAMPLES_LOCAL_ROOT", previousRoot);
    restoreEnvironmentVariable("VGPU_EXAMPLES_ARTIFACT_STORE", previousStore);
    await rm(root, { recursive: true, force: true });
  }
}

function restoreEnvironmentVariable(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("local artifact reads reject an already-aborted request", async () => {
  await withLocalArtifact(DISCOVERY_ARTIFACT_KEY, "{}\n", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled before storage read", "AbortError");
    controller.abort(reason);

    await expect(readMutableArtifact(DISCOVERY_ARTIFACT_KEY, { signal: controller.signal })).rejects.toBe(reason);
  });
});

test("local artifact reads reject cancellation that arrives while reading", async () => {
  await withLocalArtifact(DISCOVERY_ARTIFACT_KEY, "{}\n", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled during storage read", "AbortError");

    const pending = readMutableArtifact(DISCOVERY_ARTIFACT_KEY, { signal: controller.signal });
    queueMicrotask(() => controller.abort(reason));

    await expect(pending).rejects.toBe(reason);
  });
});

test("revision artifact reads reject an already-aborted request", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled before revision read", "AbortError");
  controller.abort(reason);

  await expect(readRevisionArtifact("a".repeat(64), "unrelated", { signal: controller.signal })).rejects.toBe(reason);
});

test("revision artifact reads reject cancellation that arrives while reading", async () => {
  const revision = "a".repeat(64);
  const key = `examples/v1/revisions/${revision}/revision.json`;
  await withLocalArtifact(key, `${JSON.stringify({ revision, objects: [] })}\n`, async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled during revision read", "AbortError");

    const pending = readRevisionArtifact(revision, key, { signal: controller.signal });
    queueMicrotask(() => controller.abort(reason));

    await expect(pending).rejects.toBe(reason);
  });
});

test("Blob artifact reads cancel and release a pending stream on request abort", async () => {
  const previousStore = process.env.VGPU_EXAMPLES_ARTIFACT_STORE;
  const previousToken = process.env.VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN;
  let readStarted!: () => void;
  let finishRead!: (result: { done: true; value?: undefined }) => void;
  let failRead!: (error: Error) => void;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const reader = {
    read: vi.fn(() => {
      readStarted();
      return new Promise<{ done: true; value?: undefined }>((resolve, reject) => {
        finishRead = resolve;
        failRead = reject;
      });
    }),
    cancel: vi.fn(async () => { failRead(new TypeError("Blob reader cancelled")); }),
    releaseLock: vi.fn(),
  };
  blobGet.mockResolvedValue({ stream: { getReader: () => reader } });
  try {
    process.env.VGPU_EXAMPLES_ARTIFACT_STORE = "blob";
    process.env.VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN = "test-token";
    const controller = new AbortController();
    const reason = new DOMException("cancelled during Blob read", "AbortError");
    let promptRejection: unknown;
    const pending = readMutableArtifact(DISCOVERY_ARTIFACT_KEY, { signal: controller.signal }).then(
      () => undefined,
      (error) => { promptRejection = error; return error; },
    );

    await started;
    controller.abort(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observedBeforeManualRelease = promptRejection;
    if (!reader.cancel.mock.calls.length) finishRead({ done: true });

    await expect(pending).resolves.toBe(reason);
    expect(observedBeforeManualRelease).toBe(reason);
    expect(reader.cancel).toHaveBeenCalledWith(reason);
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  } finally {
    blobGet.mockReset();
    restoreEnvironmentVariable("VGPU_EXAMPLES_ARTIFACT_STORE", previousStore);
    restoreEnvironmentVariable("VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN", previousToken);
  }
});
