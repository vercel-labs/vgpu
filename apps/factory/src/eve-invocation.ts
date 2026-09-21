import { cp, lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const INVOCATION_INPUTS = [
  "agent",
  "src",
  "evals",
  "package.json",
  "tsconfig.json",
] as const;

const EXCLUDED_NAMES = new Set([".eve", ".workflow-data", "node_modules"]);

/**
 * Eve recovers workflows from the app root, even after its previous process
 * was terminated. Give every invocation a fresh root and retain its private
 * artifacts for inspection; subsequent invocations never reuse this path.
 */
export async function createEveInvocation(
  sourceAppRoot: string
): Promise<{ appRoot: string }> {
  // Keep this outside the source tree: Eve excludes paths beneath `.eve`
  // while materializing development snapshots from the repository root.
  const appRoot = await mkdtemp(join(tmpdir(), "vgpu-factory-"));
  try {
    for (const input of INVOCATION_INPUTS) {
      await cp(join(sourceAppRoot, input), join(appRoot, input), {
        recursive: true,
        filter: async (path) => {
          const name = basename(path);
          if (name.startsWith(".env") || EXCLUDED_NAMES.has(name)) return false;
          if ((await lstat(path)).isSymbolicLink()) {
            throw new Error(
              "Factory invocation source contains a symbolic link."
            );
          }
          return true;
        },
      });
    }
    await symlink(
      await realpath(join(sourceAppRoot, "node_modules")),
      join(appRoot, "node_modules"),
      "junction"
    );
    return { appRoot };
  } catch (error) {
    // Preparation never started Eve; remove only this incomplete, owned copy.
    await rm(appRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
