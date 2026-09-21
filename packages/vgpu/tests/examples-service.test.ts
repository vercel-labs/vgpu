import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExamplesService } from "../lib/examples/service.js";
import { createLocalExamplesService } from "../lib/examples/local-service.js";

const revision = "a".repeat(64);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function tempDirectory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

function example(id: string, title: string, tags: string[] = []) {
  return {
    id,
    title,
    description: `${title} example`,
    tags,
    capabilities: [],
    fileCount: 1,
    aggregateSha256: "b".repeat(64),
    manifestUrl: `https://vgpu.sh/${id}/manifest.json`,
    manifestSha256: "c".repeat(64),
  };
}

function downloadFixture() {
  const entry = example("gradient", "Gradient");
  const index = { revision, examples: [entry] };
  const manifest = {
    revision,
    id: "gradient",
    aggregateSha256: entry.aggregateSha256,
    files: [{ path: "example.ts", contentType: "text/typescript", size: 4, sha256: "d".repeat(64), url: "https://vgpu.sh/example.ts" }],
  };
  return {
    entry,
    index,
    manifest,
    source: {
      getIndex: async () => ({ index, offline: false }),
      getManifest: async () => manifest,
      getFile: async () => Buffer.from("new\n"),
    },
  };
}

test("examples service searches a repository with the canonical ranking", async () => {
  const source = {
    getIndex: async () => ({
      index: {
        schemaVersion: 1,
        contractId: "vgpu-examples/v1",
        revision,
        source: { repository: "vgpu", gitCommit: "test" },
        examples: [example("other", "Raymarch notes"), example("raymarched-fractal", "Fractal", ["raymarching"])],
      },
      offline: false,
    }),
  };
  const examples = createExamplesService({ source });

  const result = await examples.execute({ operation: "search", query: "raymarching" });

  expect(result).toMatchObject({
    operation: "search",
    revision,
    results: [{ id: "raymarched-fractal", score: 60 }, { id: "other", score: 35 }],
  });
});

test("examples service shows a manifest from the selected revision", async () => {
  const entry = example("gradient", "Gradient");
  const index = {
    schemaVersion: 1,
    contractId: "vgpu-examples/v1",
    revision,
    source: { repository: "vgpu", gitCommit: "test" },
    examples: [entry],
  };
  const manifest = {
    schemaVersion: 1,
    contractId: "vgpu-examples/v1",
    revision,
    id: "gradient",
    title: "Gradient",
    description: "Gradient example",
    tags: [],
    capabilities: [],
    aggregateSha256: entry.aggregateSha256,
    files: [{ path: "example.ts", contentType: "text/typescript", size: 5, sha256: "d".repeat(64), url: "https://vgpu.sh/example.ts" }],
  };
  const source = {
    getIndex: async () => ({ index, offline: false }),
    getManifest: async () => manifest,
  };
  const examples = createExamplesService({ source });

  await expect(examples.execute({ operation: "show", id: "gradient", revision })).resolves.toEqual({
    operation: "show",
    manifest,
  });
});

test("examples service reads a verified source file as structured text", async () => {
  const file = {
    path: "example.ts",
    contentType: "text/typescript",
    size: 24,
    sha256: "d".repeat(64),
    url: "https://vgpu.sh/example.ts",
  };
  const index = { revision, examples: [example("gradient", "Gradient")] };
  const manifest = { revision, id: "gradient", files: [file] };
  const source = {
    getIndex: async () => ({ index, offline: false }),
    getManifest: async () => manifest,
    getFile: async () => Buffer.from("export const value = 1;\n"),
  };
  const examples = createExamplesService({ source });

  await expect(examples.execute({ operation: "read", id: "gradient", path: "example.ts" })).resolves.toEqual({
    operation: "read",
    revision,
    id: "gradient",
    path: "example.ts",
    contentType: "text/typescript",
    size: 24,
    sha256: file.sha256,
    content: "export const value = 1;\n",
  });
});

test("examples service downloads into a new directory beneath its configured output directory", async () => {
  const root = await tempDirectory("vgpu-mcp-download-");
  const { entry, source } = downloadFixture();
  const examples = createLocalExamplesService({ source, downloadRoot: root });

  const result = await examples.execute({
    operation: "download",
    id: "gradient",
    destination: "examples/gradient",
  });

  expect(result).toEqual({
    operation: "download",
    revision,
    id: "gradient",
    destination: await realpath(join(root, "examples", "gradient")),
    files: 1,
    bytes: 4,
    aggregateSha256: entry.aggregateSha256,
  });
  expect(await readFile(join(root, "examples", "gradient", "example.ts"), "utf8")).toBe("new\n");
});

test("local examples service requires an explicit download boundary", () => {
  const source = {
    getIndex: async () => { throw new Error("must not access the examples repository"); },
  };

  expect(() => createLocalExamplesService({ source })).toThrow(
    "Local examples service requires an explicit download root",
  );
});

test("examples service rejects an existing destination before discovery", async () => {
  const root = await tempDirectory("vgpu-mcp-existing-");
  await mkdir(join(root, "existing"));
  let sourceCalls = 0;
  const source = {
    getIndex: async () => {
      sourceCalls += 1;
      throw new Error("must not access the examples repository");
    },
  };
  const examples = createLocalExamplesService({ source, downloadRoot: root });

  await expect(examples.execute({
    operation: "download",
    id: "gradient",
    destination: "existing",
  })).rejects.toMatchObject({
    code: "VGPU-EXAMPLES-DESTINATION-EXISTS",
    message: `Destination already exists: ${join(root, "existing")}`,
  });
  expect(sourceCalls).toBe(0);
});

test.runIf(["linux", "darwin"].includes(process.platform))(
  "examples service rejects a symlink destination ancestor before discovery",
  async () => {
    const sandbox = await tempDirectory("vgpu-mcp-symlink-ancestor-");
    const root = join(sandbox, "root");
    const outside = join(sandbox, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "linked"), "dir");
    let sourceCalls = 0;
    const source = {
      getIndex: async () => {
        sourceCalls += 1;
        throw new Error("must not access the examples repository");
      },
    };
    const examples = createLocalExamplesService({ source, downloadRoot: root });

    await expect(examples.execute({
      operation: "download",
      id: "gradient",
      destination: "linked/gradient",
    })).rejects.toMatchObject({
      code: "VGPU-EXAMPLES-FILESYSTEM",
      message: "Download destination must not traverse a symbolic link",
    });
    expect(sourceCalls).toBe(0);
    expect(await readdir(outside)).toEqual([]);
  },
);

test.runIf(process.platform === "darwin")(
  "examples service returns the real canonical path through a case-insensitive parent alias",
  async () => {
    const root = await tempDirectory("vgpu-mcp-case-alias-");
    const canonicalParent = join(root, "examples");
    const aliasedParent = join(root, "EXAMPLES");
    await mkdir(canonicalParent);
    let aliasesExistingParent = false;
    try {
      aliasesExistingParent = await realpath(aliasedParent) === await realpath(canonicalParent);
    } catch {
      // A case-sensitive macOS volume cannot exercise this platform-specific regression.
    }
    if (!aliasesExistingParent) return;

    const { source } = downloadFixture();
    const examples = createLocalExamplesService({ source, downloadRoot: root });

    const result = await examples.execute({
      operation: "download",
      id: "gradient",
      destination: "EXAMPLES/gradient",
    });

    expect(result.destination).toBe(await realpath(result.destination));
    expect(result.destination).toBe(join(await realpath(canonicalParent), "gradient"));
  },
);

test("cancelling an examples download aborts its reads and leaves no filesystem remnants", async () => {
  const root = await tempDirectory("vgpu-mcp-cancel-");
  const controller = new AbortController();
  const { index, manifest } = downloadFixture();
  const seenSignals: Array<AbortSignal | undefined> = [];
  const source = {
    getIndex: async (options: { signal?: AbortSignal }) => {
      seenSignals.push(options.signal);
      return { index, offline: false };
    },
    getManifest: async (_index: unknown, _id: string, options: { signal?: AbortSignal }) => {
      seenSignals.push(options.signal);
      return manifest;
    },
    getFile: async (_manifest: unknown, _file: unknown, options: { signal?: AbortSignal }) => {
      seenSignals.push(options.signal);
      controller.abort();
      options.signal?.throwIfAborted();
      throw new Error("download read did not observe cancellation");
    },
  };
  const examples = createLocalExamplesService({ source, downloadRoot: root });

  await expect(examples.execute(
    { operation: "download", id: "gradient", destination: "gradient" },
    { signal: controller.signal },
  )).rejects.toMatchObject({ name: "AbortError" });

  expect(seenSignals).toEqual([controller.signal, controller.signal, controller.signal]);
  expect(await readdir(root)).toEqual([]);
});

test("examples service rejects download paths outside its configured output directory", async () => {
  const root = await tempDirectory("vgpu-mcp-root-");
  const source = {
    getIndex: async () => { throw new Error("must not access the examples repository"); },
  };
  const examples = createLocalExamplesService({ source, downloadRoot: root });

  await expect(examples.execute({
    operation: "download",
    id: "gradient",
    destination: "../escape",
  })).rejects.toMatchObject({
    code: "VGPU-EXAMPLES-USAGE",
    message: "Download destination must stay inside the configured output directory",
  });
});

test("examples service rejects unsafe or non-normalized download destinations before discovery", async () => {
  const root = await tempDirectory("vgpu-mcp-destination-");
  const source = {
    getIndex: async () => { throw new Error("must not access the examples repository"); },
  };
  const examples = createLocalExamplesService({ source, downloadRoot: root });
  const invalid = [
    "/absolute",
    "C:\\absolute",
    "nested/../escape",
    "nested/./example",
    "nested//example",
    "nested/",
    ".",
    "%2e%2e/escape",
    `control-${String.fromCharCode(0)}`,
    `control-${String.fromCharCode(0x85)}`,
    `ill-formed-${String.fromCharCode(0xd800)}`,
    `bidi-${String.fromCodePoint(0x202e)}name`,
    `isolate-${String.fromCodePoint(0x2066)}name`,
  ];

  for (const destination of invalid) {
    await expect(examples.execute({
      operation: "download",
      id: "gradient",
      destination,
    }), destination).rejects.toMatchObject({ code: "VGPU-EXAMPLES-USAGE" });
  }
});

test("examples service preserves offline mode across repository reads", async () => {
  const calls: Array<{ method: string; offline?: boolean }> = [];
  const source = {
    getIndex: async (options: { offline?: boolean }) => {
      calls.push({ method: "index", offline: options.offline });
      return { index: { revision, examples: [example("gradient", "Gradient")] }, offline: true, lastVerifiedAt: "2026-08-24T00:00:00.000Z" };
    },
    getManifest: async (_index: unknown, _id: string, options: { offline?: boolean }) => {
      calls.push({ method: "manifest", offline: options.offline });
      return { revision, id: "gradient", files: [] };
    },
  };
  const examples = createExamplesService({ source });

  const result = await examples.execute({ operation: "show", id: "gradient", offline: true });

  expect(calls).toEqual([
    { method: "index", offline: true },
    { method: "manifest", offline: true },
  ]);
  expect(result).toMatchObject({ lastVerifiedAt: "2026-08-24T00:00:00.000Z" });
});
