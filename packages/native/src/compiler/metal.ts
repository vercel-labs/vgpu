import {
  execFile,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetalCompileError } from "./errors.js";

export async function compileMetalLibrary(
  sources: readonly string[],
  signal?: AbortSignal,
  options: { readonly environment?: NodeJS.ProcessEnv } = {}
): Promise<Uint8Array> {
  const environment = options.environment && { ...options.environment };
  const directory = await mkdtemp(
    join(environment?.TMPDIR ?? tmpdir(), "vgpu-metal-build-")
  );
  try {
    signal?.throwIfAborted();
    const airFiles: string[] = [];
    for (const [index, source] of sources.entries()) {
      signal?.throwIfAborted();
      const msl = join(directory, `stage-${index}.metal`);
      const air = join(directory, `stage-${index}.air`);
      await writeFile(msl, source, "utf8");
      signal?.throwIfAborted();
      await execute(
        "/usr/bin/xcrun",
        [
          "-sdk",
          "macosx",
          "metal",
          "-std=macos-metal2.4",
          "-target",
          "air64-apple-macos14.0",
          "-c",
          msl,
          "-o",
          air,
        ],
        {
          env: environment,
          signal,
          timeout: 45_000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        }
      );
      airFiles.push(air);
    }
    signal?.throwIfAborted();
    const library = join(directory, "Shaders.metallib");
    await execute(
      "/usr/bin/xcrun",
      ["-sdk", "macosx", "metallib", ...airFiles, "-o", library],
      {
        env: environment,
        signal,
        timeout: 45_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      }
    );
    return await readFile(library);
  } catch (cause) {
    throw new MetalCompileError(
      "metal",
      `Offline Metal compilation failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function execute(
  executable: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding
): Promise<void> {
  return new Promise((resolve, reject) => {
    let result: { error: Error | null } | undefined;
    const child = execFile(executable, args, options, (error) => {
      result = { error };
    });
    child.once("close", () => {
      if (!result) reject(new Error("Metal process closed without a result."));
      else if (result.error) reject(result.error);
      else resolve();
    });
    child.stdin?.end();
  });
}
