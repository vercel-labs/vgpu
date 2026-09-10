import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { snapshotTarPath, snapshotWorkspaceDir } from "../../agent/lib/paths.ts";

/**
 * Transcript and workspace helpers shared by the `n2-ship-hero` /
 * `n3-explore-hero` pair.
 *
 * `s2-gradient.eval.ts` and `n1-hero-shader.eval.ts` carry their own copies of
 * `bashCalls` and the file walkers on purpose (see n1's comment: a green
 * regression run of the reference pattern is worth more than the dedupe). This
 * module exists because the new pair is two tasks sharing one seed and one
 * grading vocabulary, and duplicating the helpers a third and fourth time would
 * make the pair drift from each other, which is the one thing a control task
 * must not do. Folding s2/n1 into it is a follow-up that needs its own
 * comparability run.
 */

export interface ToolCallLike {
  name: string;
  input?: unknown;
  output?: unknown;
}

export interface BashCall {
  command: string;
  exitCode: number | null;
  output: string;
}

/** Bash calls with their real exit codes; the sandbox's stderr carries Vulkan chatter, so never grep it for "error". */
export function bashCalls(toolCalls: readonly ToolCallLike[]): BashCall[] {
  return toolCalls
    .filter((call) => call.name === "bash")
    .map((call) => {
      const input = call.input as { command?: unknown } | undefined;
      const output = call.output as { exitCode?: unknown; stdout?: unknown; stderr?: unknown } | undefined;
      return {
        command: String(input?.command ?? ""),
        exitCode: typeof output?.exitCode === "number" ? output.exitCode : null,
        output: `${String(output?.stdout ?? "")}\n${String(output?.stderr ?? "")}`,
      };
    });
}

/**
 * What the agent wrote while working, chronologically: every write_file payload
 * and every bash command's text (heredocs, `sed -i`, `node -e` all write files
 * through bash). Order matters because judge material is capped from the end.
 */
export function writtenUnits(toolCalls: readonly ToolCallLike[]): string[] {
  return toolCalls.flatMap((call) => {
    if (call.name === "write_file") {
      return [String((call.input as { content?: unknown } | undefined)?.content ?? "")];
    }
    if (call.name === "bash") {
      return [String((call.input as { command?: unknown } | undefined)?.command ?? "")];
    }
    return [];
  });
}

/** `vgpu docs` usage: calls, real invocation count (one call can chain several), and whether a given doc was opened. */
export function docsUsage(calls: readonly BashCall[]) {
  const docsCalls = calls.filter((call) => /vgpu\s+docs\b/.test(call.command));
  const invocations = docsCalls.reduce(
    (total, call) => total + (call.command.match(/vgpu\s+docs\s+\S+/g)?.length ?? 0),
    0,
  );
  return {
    docsCalls,
    invocations,
    /** The agent asked for this doc by name (`cat`, `path`, `find`/`grep` with the slug). Listing the index does not count. */
    opened: (slug: string) => docsCalls.some((call) => call.command.includes(slug)),
    /** The doc's slug appeared in some docs output, e.g. an index listing or a search hit. */
    surfaced: (slug: string) => docsCalls.some((call) => call.output.includes(slug)),
  };
}

/** Extracts this session's workspace tar; returns where, plus the tar path for the freshness gate. */
export function extractSnapshot(sessionId: string): { tarPath: string; extracted: string } {
  const tarPath = snapshotTarPath(sessionId);
  if (!existsSync(tarPath)) {
    throw new Error(`workspace export missing at ${tarPath} (the finalize-turn hook did not run; infra, not an agent result)`);
  }
  const extracted = snapshotWorkspaceDir(sessionId);
  rmSync(extracted, { force: true, recursive: true });
  mkdirSync(extracted, { recursive: true });
  const untar = spawnSync("tar", ["-xf", tarPath, "-C", extracted], { encoding: "utf8" });
  if (untar.status !== 0) throw new Error(`could not extract ${tarPath}: ${untar.stderr}`);
  return { tarPath, extracted };
}

export interface SourceFile {
  /** Path relative to the walked root, POSIX separators. */
  path: string;
  content: string;
}

const DEFAULT_SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vgpu-tarballs", ".agent-evals"]);

/** Source files under `root`, one entry per file, filtered by extension. */
export function sourceFiles(
  root: string,
  extensions: ReadonlySet<string>,
  skipDirs: ReadonlySet<string> = DEFAULT_SKIP_DIRS,
): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        files.push({ path: relative(root, full).split(sep).join("/"), content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Unified diff of the seed tree against what the agent shipped, restricted to
 * source-ish files. `diff -ruN` so added and deleted files show up whole. The
 * result is untrusted (the agent wrote half of it); it is judge MATERIAL only.
 */
export function seedDiff(seedDir: string, shippedDir: string, limit = 24_000): string {
  // package.json / package-lock.json are excluded because bootstrap's tarball
  // install rewrites them on every run (it saves the vgpu closure as file:
  // dependencies), which would put the same agent-unrelated hunk in front of
  // every judge. PR.md is graded on its own, not as a diff hunk. next-env.d.ts
  // and *.tsbuildinfo are rewritten by Next's own typegen whenever the agent
  // builds or type-checks; on the first live n3 run that one generated hunk
  // was the only thing standing between "scope discipline" and a yes.
  const excludes = [
    ...DEFAULT_SKIP_DIRS,
    "package.json",
    "package-lock.json",
    "PR.md",
    "next-env.d.ts",
    "*.tsbuildinfo",
    "*.pid",
    "*.log",
  ].flatMap((pattern) => [
    "--exclude",
    pattern,
  ]);
  const result = spawnSync("diff", ["-ruN", ...excludes, seedDir, shippedDir], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // diff exits 1 when files differ; only 2+ is an error.
  if (result.status !== null && result.status > 1) {
    return `(diff failed: ${result.stderr.trim().slice(0, 300)})`;
  }
  const text = result.stdout.replaceAll(seedDir, "<seed>").replaceAll(shippedDir, "<shipped>");
  return text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text;
}

/**
 * Per-unit and overall caps for judge material, so neither one huge file nor a
 * long transcript crowds out the rest. Each judge call is billed.
 */
export function capJudgeMaterial(units: readonly string[], unitLimit = 4000, totalLimit = 20_000): string {
  const sections: string[] = [];
  let used = 0;
  for (const unit of units) {
    if (!unit || used >= totalLimit) continue;
    const room = Math.min(unitLimit, totalLimit - used);
    const piece = unit.length > room ? `${unit.slice(0, room)}\n…[truncated]` : unit;
    sections.push(piece);
    used += piece.length;
  }
  return sections.join("\n\n---\n\n");
}
