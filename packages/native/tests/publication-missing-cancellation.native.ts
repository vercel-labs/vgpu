import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  controller: undefined as AbortController | undefined,
  phase: "published" as "prepared" | "published",
}));
// Abort at an actual helper response boundary; preserve the real protocol and syscall results.
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (boundary.controller && args[0].endsWith("/publication-staging")) {
        let response = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          response += chunk.toString("utf8");
          const marker =
            boundary.phase === "prepared"
              ? '"kind":"prepared"'
              : '"outcome":"published"';
          if (response.includes(marker))
            boundary.controller?.abort(
              new Error(`cancelled after actual ${boundary.phase} response`)
            );
        });
      }
      return child;
    }) as typeof actual.spawn,
  };
});
import { prepareMetalProject } from "../src/tooling/prepare-project.ts";
import { publishPreparedMetalOutput } from "../src/tooling/publication-staging.ts";
import { verifyMetalProject } from "../src/tooling/verify-project.ts";
import { projectFixture } from "./project-operation-fixture.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test.each(["prepared", "published"] as const)(
  "cancellation at the actual %s response preserves the correct publication outcome",
  async (phase) => {
    const input = await projectFixture();
    try {
      const prepared = await prepareMetalProject({
        configurationPath: input.configurationPath,
        workerPath,
      });
      const controller = new AbortController();
      boundary.phase = phase;
      boundary.controller = controller;
      const error = await publishPreparedMetalOutput({
        prepared,
        signal: controller.signal,
      }).catch((cause: unknown) => cause);
      expect(controller.signal.aborted).toBe(true);
      expect(error).toMatchObject({
        outcome: phase === "published" ? "published" : "not-published",
        code: "cancelled",
        cause: { code: "cancelled", cause: controller.signal.reason },
      });
      const parent = dirname(input.outputPath);
      if (phase === "published") {
        const output = await lstat(input.outputPath, { bigint: true });
        expect(error).toMatchObject({
          receipt: {
            outcome: "published",
            outputPath: input.outputPath,
            output: {
              device: output.dev.toString(),
              inode: output.ino.toString(),
            },
          },
          recoveryPaths: [],
        });
        for (const [name, bytes] of Object.entries(prepared.files))
          expect(await readFile(join(input.outputPath, name))).toEqual(
            Buffer.from(bytes)
          );
        await expect(
          verifyMetalProject({ configurationPath: input.configurationPath })
        ).resolves.toMatchObject({ outputPath: input.outputPath });
        expect(await readdir(parent)).toEqual(["AppShaders"]);
      } else {
        await expect(lstat(input.outputPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        const stage = join(parent, ".vgpu-native-stage");
        const journal = join(parent, ".vgpu-native-publication.json");
        expect(error).toMatchObject({
          receipt: undefined,
          recoveryPaths: [stage, journal],
        });
        expect(JSON.parse(await readFile(journal, "utf8"))).toMatchObject({
          phase: "prepared",
          publication: { renameMode: "excl", expectedDestination: "missing" },
        });
        for (const [name, bytes] of Object.entries(prepared.files))
          expect(await readFile(join(stage, name))).toEqual(Buffer.from(bytes));
        expect((await readdir(parent)).sort()).toEqual([
          ".vgpu-native-publication.json",
          ".vgpu-native-stage",
        ]);
      }
    } finally {
      boundary.controller = undefined;
      await rm(input.directory, { recursive: true, force: true });
    }
  }
);
