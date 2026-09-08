import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MetalCompileError } from "./errors.js";

const execute = promisify(execFile);

export async function compileMetalLibrary(
  sources: readonly string[],
  signal?: AbortSignal
): Promise<Uint8Array> {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-metal-build-"));
  try {
    const airFiles: string[] = [];
    for (const [index, source] of sources.entries()) {
      const msl = join(directory, `stage-${index}.metal`);
      const air = join(directory, `stage-${index}.air`);
      await writeFile(msl, source, "utf8");
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
          signal,
          timeout: 45_000,
          killSignal: "SIGKILL",
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        }
      );
      airFiles.push(air);
    }
    const library = join(directory, "Shaders.metallib");
    await execute(
      "/usr/bin/xcrun",
      ["-sdk", "macosx", "metallib", ...airFiles, "-o", library],
      {
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
