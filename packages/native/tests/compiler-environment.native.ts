import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";

const processBoundary = vi.hoisted(() => ({
  observed: [] as { executable: string; environment: NodeJS.ProcessEnv }[],
}));
// Observe actual process inputs, without substituting the authenticated worker or its output.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      const options = args[2] as import("node:child_process").SpawnOptions;
      processBoundary.observed.push({
        executable: args[0],
        environment: { ...options.env },
      });
      return child;
    }) as typeof actual.spawn,
  };
});
import { invokeTintWorker } from "../src/compiler/worker.ts";

const executable = fileURLToPath(
  new URL(
    "../../../experiments/native-metal-spikes/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);
const roots: string[] = [];
afterEach(async () => {
  processBoundary.observed.length = 0;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-worker-environment-"))
  );
  roots.push(root);
  const scratch = join(root, "Scratch");
  await mkdir(scratch);
  await writeFile(join(scratch, "keep.txt"), "not worker-owned");
  return { root, scratch };
}

function inventoryRequest(): string {
  const hash = (text: string) =>
    createHash("sha256").update(text).digest("hex");
  const text = "// explicit compiler environment probe\n";
  const virtualPath = "Intermediate/environment.wgsl";
  const sha256 = hash(text);
  const originMap = {
    contractId: "vgpu-native-origin-map/v1",
    generatedSource: { sha256, virtualPath },
    schemaVersion: 1,
    segments: [],
    sources: [{ input: "environment-wgsl", sha256 }],
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

test("the real pinned worker uses its owned entry-time context and removes explicit loader overrides", async () => {
  const { root, scratch } = await fixture();
  const original = process.cwd();
  const other = join(root, "Other");
  await mkdir(other);
  const environment: NodeJS.ProcessEnv = {
    TMPDIR: "Scratch",
    DEVELOPER_DIR: "SelectedXcode",
    VGPU_CONTEXT_MARKER: "selected",
    DYLD_PRINT_LIBRARIES: "1",
    LD_PRELOAD: "/does-not-exist/worker-injection.so",
    LD_LIBRARY_PATH: "/does-not-exist/worker-libraries",
  };
  try {
    process.chdir(root);
    const pending = invokeTintWorker({
      executable,
      request: inventoryRequest(),
      environment,
    });
    environment.TMPDIR = "changed-scratch";
    environment.DEVELOPER_DIR = "changed-xcode";
    environment.VGPU_CONTEXT_MARKER = "changed";
    process.chdir(other);
    expect(await pending).toMatchObject({
      ok: true,
      result: { entryPoints: [] },
    });
  } finally {
    process.chdir(original);
  }
  expect(processBoundary.observed).toHaveLength(1);
  const observed = processBoundary.observed[0];
  expect(observed.environment.TMPDIR).toBe(scratch);
  expect(observed.environment.DEVELOPER_DIR).toBe(join(root, "SelectedXcode"));
  expect(observed.environment.VGPU_CONTEXT_MARKER).toBe("selected");
  expect(
    Object.keys(observed.environment).filter(
      (name) => name.startsWith("DYLD_") || name.startsWith("LD_")
    )
  ).toEqual([]);
  expect(dirname(dirname(observed.executable))).toBe(scratch);
  expect(await readdir(scratch)).toEqual(["keep.txt"]);
  expect(await readdir(other)).toEqual([]);
});

test("a real worker failure cleans only its private copy inside the selected scratch directory", async () => {
  const { scratch } = await fixture();
  const environment = { TMPDIR: scratch, VGPU_CONTEXT_MARKER: "selected" };
  await expect(
    invokeTintWorker({ executable, request: "{", environment })
  ).rejects.toMatchObject({
    code: "process-failed",
    message: expect.stringContaining("65"),
  });
  expect(processBoundary.observed).toHaveLength(1);
  expect(dirname(dirname(processBoundary.observed[0].executable))).toBe(
    scratch
  );
  expect(await readdir(scratch)).toEqual(["keep.txt"]);
  expect(environment).toEqual({
    TMPDIR: scratch,
    VGPU_CONTEXT_MARKER: "selected",
  });
});
