import { aggregateSha256, sha256 } from "@vgpu/cli/lib/examples/hashing.js";
import { EXAMPLES_SCHEMA_SHA256 } from "@vgpu/cli/lib/examples/contracts.js";
import { expect, test, vi } from "vitest";
import { createArtifactExamplesSource } from "./artifact-examples-source";

const revision = "a".repeat(64);
const origin = "http://127.0.0.1:43123";
const base = `examples/v1/revisions/${revision}`;

function artifact(value: unknown, contentType = "application/json; charset=utf-8") {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(`${JSON.stringify(value)}\n`);
  return { bytes, contentType, sha256: sha256(bytes) };
}

test("artifact examples source reuses the CLI client without making network requests", async () => {
  const fileText = "export const gradient = true;\n";
  const file = {
    path: "example.ts",
    contentType: "text/typescript",
    size: Buffer.byteLength(fileText),
    sha256: sha256(Buffer.from(fileText)),
    url: `${origin}/api/${base}/examples/gradient/files/example.ts.raw`,
  };
  const manifest = {
    schemaVersion: 1,
    contractId: "vgpu-examples/v1",
    revision,
    id: "gradient",
    title: "Gradient",
    description: "A small gradient example.",
    tags: ["gradient"],
    capabilities: ["webgpu"],
    aggregateSha256: "",
    files: [file],
  };
  manifest.aggregateSha256 = aggregateSha256(manifest);
  const manifestArtifact = artifact(manifest);
  const index = {
    schemaVersion: 1,
    contractId: "vgpu-examples/v1",
    revision,
    source: { repository: "https://github.com/vgpu/vgpu", gitCommit: "test" },
    examples: [{
      id: manifest.id,
      title: manifest.title,
      description: manifest.description,
      tags: manifest.tags,
      capabilities: manifest.capabilities,
      fileCount: manifest.files.length,
      aggregateSha256: manifest.aggregateSha256,
      manifestUrl: `${origin}/api/${base}/examples/gradient/manifest.json`,
      manifestSha256: manifestArtifact.sha256,
    }],
  };
  const indexArtifact = artifact(index);
  const mutable = new Map([
    [".well-known/vgpu-examples.json", artifact({
      protocol: "vgpu-examples",
      discoveryVersion: 1,
      contracts: [{
        id: "vgpu-examples/v1",
        schemaSha256: EXAMPLES_SCHEMA_SHA256,
        status: "active",
        minimumCliVersion: "0.1.0",
        indexUrl: `${origin}/api/examples/v1/latest.json`,
      }],
    })],
    ["examples/v1/latest.json", artifact({
      schemaVersion: 1,
      contractId: "vgpu-examples/v1",
      revision,
      indexUrl: `${origin}/api/${base}/index.json`,
      indexSha256: indexArtifact.sha256,
    })],
  ]);
  const immutable = new Map([
    [`${base}/index.json`, indexArtifact],
    [`${base}/examples/gradient/manifest.json`, manifestArtifact],
    [`${base}/examples/gradient/files/example.ts.raw`, artifact(fileText, "text/typescript; charset=utf-8")],
  ]);
  const reads: string[] = [];
  const source = createArtifactExamplesSource({
    baseUrl: origin,
    version: "0.3.0",
    readMutable: async (key) => { reads.push(key); return mutable.get(key); },
    readRevision: async (_revision, key) => { reads.push(key); return immutable.get(key); },
  });
  expect(source.cache).toMatchObject({ persistent: false, maxMemoryBytes: 8 * 1024 * 1024 });

  const state = await source.getIndex();
  const loadedManifest = await source.getManifest(state.index, "gradient");
  const bytes = await source.getFile(loadedManifest, loadedManifest.files[0]);

  expect(bytes.toString("utf8")).toBe(fileText);
  expect(reads).toEqual([
    ".well-known/vgpu-examples.json",
    "examples/v1/latest.json",
    `${base}/index.json`,
    `${base}/examples/gradient/manifest.json`,
    `${base}/examples/gradient/files/example.ts.raw`,
  ]);
});

test("artifact examples source cancels a pending artifact read promptly", async () => {
  let readStarted!: () => void;
  let finishRead!: (artifact: undefined) => void;
  let receivedSignal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  const source = createArtifactExamplesSource({
    version: "0.3.0",
    readMutable: async (_key, options) => {
      receivedSignal = options?.signal;
      readStarted();
      return new Promise<undefined>((resolve) => { finishRead = resolve; });
    },
    readRevision: async () => undefined,
  });
  const controller = new AbortController();
  const reason = new DOMException("cancelled by test", "AbortError");
  let promptRejection: unknown;
  const pending = source.getIndex({ signal: controller.signal } as {
    revision?: string;
    offline?: boolean;
    signal?: AbortSignal;
  }).then(() => undefined, (error) => {
    promptRejection = error;
    return error;
  });

  await started;
  controller.abort(reason);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const observedBeforeReaderFinished = promptRejection;
  finishRead(undefined);

  await expect(pending).resolves.toBe(reason);
  expect(receivedSignal).toBeDefined();
  expect(observedBeforeReaderFinished).toBe(reason);
});

test("artifact examples source times out a pending artifact read promptly", async () => {
  vi.useFakeTimers();
  try {
    let readStarted!: () => void;
    let finishRead!: (artifact: undefined) => void;
    let receivedSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const source = createArtifactExamplesSource({
      version: "0.3.0",
      readMutable: async (_key, options) => {
        receivedSignal = options?.signal;
        readStarted();
        return new Promise<undefined>((resolve) => { finishRead = resolve; });
      },
      readRevision: async () => undefined,
    });
    source.timeoutMs = 25;
    let promptRejection: unknown;
    const pending = source.getIndex().then(() => undefined, (error) => {
      promptRejection = error;
      return error;
    });

    await started;
    await vi.advanceTimersByTimeAsync(25);
    const observedBeforeReaderFinished = promptRejection;
    finishRead(undefined);

    await expect(pending).resolves.toMatchObject({
      code: "VGPU-EXAMPLES-NETWORK",
      message: expect.stringContaining("Request timed out"),
    });
    expect(receivedSignal?.aborted).toBe(true);
    expect(observedBeforeReaderFinished).toMatchObject({
      code: "VGPU-EXAMPLES-NETWORK",
      message: expect.stringContaining("Request timed out"),
    });
  } finally {
    vi.useRealTimers();
  }
});
