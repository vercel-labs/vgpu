import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const leasePath = path.join(tmpdir(), `vgpu-performance-${process.getuid?.() ?? "user"}.lease`);

/** mkdir is atomic across worktrees. Never automatically steal an old or malformed lease. */
export async function acquireLease(directory = leasePath) {
  try { await mkdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const owner = await readFile(path.join(directory, "owner.json"), "utf8").catch(() => "unknown owner");
    throw new Error(`GPU workload lease occupied at ${directory}: ${owner}`);
  }
  try {
    await writeFile(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), startedAt: new Date().toISOString() }));
  } catch (error) { await rm(directory, { recursive: true }); throw error; }
  return async () => { await rm(directory, { recursive: true }); };
}
