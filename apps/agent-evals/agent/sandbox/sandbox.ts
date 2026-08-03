import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineSandbox } from "eve/sandbox";
import type { SandboxSession } from "eve/sandbox";
// Plain .mjs on purpose: the pack script must run with bare `node` before
// anything in this workspace is built. Importing it here (rather than copying
// the key derivation) keeps packer and consumer from ever disagreeing.
import { sourceKey } from "../../scripts/pack-vgpu.mjs";
import { extractJson } from "../lib/extract-json.ts";
import { tarballsDir } from "../lib/paths.ts";
import { evalSandboxBackend } from "./backend.ts";

const WORKSPACE = "/workspace";
const TARBALL_DIR_IN_SANDBOX = `${WORKSPACE}/.vgpu-tarballs`;

interface TarballManifest {
  packedAt: string;
  sourceKey: string;
  gitSha: string;
  gitBranch: string;
  tarballs: { name: string; version: string; file: string }[];
}

function readManifest(): TarballManifest {
  const dir = tarballsDir();
  const manifestPath = join(dir, "tarballs.json");
  if (!existsSync(manifestPath)) {
    throw fatal(
      `bootstrap: no vgpu tarballs found at ${dir}.\n` +
        "  This tool installs the vgpu built from the CURRENT BRANCH, not the one on npm.\n" +
        "  Run `pnpm agent-evals` (which packs first) or `pnpm --filter @vgpu/agent-evals pack-vgpu`.",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TarballManifest;

  // Staleness guard. `pnpm agent-evals` packs before it runs, but `eve eval`
  // invoked directly (documented, and what you reach for when iterating on one
  // eval) does not — so without this, switching branches silently grades the
  // PREVIOUS branch's vgpu and every number you read is about the wrong code.
  const current = currentSourceKey();
  if (current !== null && manifest.sourceKey !== current) {
    throw fatal(
      `bootstrap: the vgpu tarballs in ${dir} are stale.\n` +
        `  packed from: ${manifest.gitBranch} @ ${manifest.gitSha.slice(0, 8)} (key ${manifest.sourceKey})\n` +
        `  working tree now: key ${current}\n` +
        "  Re-pack before running: `pnpm agent-evals` (packs automatically) or " +
        "`pnpm --filter @vgpu/agent-evals pack-vgpu`.",
    );
  }
  return manifest;
}

/**
 * The key for the tree as it is right now, or null when it cannot be known.
 *
 * `VGPU_EVALS_SOURCE_KEY` comes from the wrapper, which computed it in the real
 * worktree. Recomputing it here is a fallback and often wrong: under eve's dev
 * runtime this code executes from a snapshot, where `git` resolves against a cwd
 * in which the `packages/` pathspec matches nothing — producing a different key
 * and declaring freshly built tarballs stale. Returning null (skip the check)
 * beats blocking a good run on a path artefact.
 */
function currentSourceKey(): string | null {
  const fromEnv = process.env.VGPU_EVALS_SOURCE_KEY;
  if (fromEnv) return fromEnv;
  try {
    return sourceKey();
  } catch {
    return null;
  }
}

/**
 * eve retries a failing bootstrap (four attempts were observed), so a
 * multi-line diagnostic is printed four times and the real message scrolls away
 * inside three duplicates. Print the explanation once; later attempts get a
 * one-liner pointing back at it.
 */
let explained = false;
function fatal(message: string): Error {
  if (explained) {
    return new Error(`${message.split("\n")[0]} (see the first occurrence above for the full message)`);
  }
  explained = true;
  return new Error(message);
}

/**
 * Template cache key.
 *
 * It must change whenever the packed code changes, or a rebuilt branch is
 * graded against a cached sandbox holding the PREVIOUS build — the most
 * expensive way to be wrong here, because everything still looks like it
 * worked. It must ALSO stay stable when nothing changed, or every run pays for
 * a full template rebuild.
 *
 * Hashing the tarball bytes satisfied only the first: `vgpu`'s tarball is not
 * byte-reproducible across packs (its `prepack` regenerates docs), so the key
 * moved on every pack. The manifest's `sourceKey` hashes the source inputs
 * instead — see sourceKey() in scripts/pack-vgpu.mjs.
 */
function tarballsFingerprint(): string {
  const manifestPath = join(tarballsDir(), "tarballs.json");
  if (!existsSync(manifestPath)) return "no-tarballs";
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TarballManifest;
    return `vgpu-${manifest.sourceKey}`;
  } catch {
    // A revalidation key must never be the thing that fails a run; a distinct
    // constant just forces one rebuild.
    return "unreadable-manifest";
  }
}

interface DoctorReport {
  verdict: string | null;
  raw: string;
  findings: { probe?: string; status?: string; prescription?: unknown }[];
}

async function runDoctor(sandbox: SandboxSession): Promise<DoctorReport> {
  // Two things are load-bearing in this one line.
  //
  // `|| true`: eve THROWS when a `sandbox.run` command exits non-zero, and an
  // unhealthy verdict is exactly how doctor reports itself (exit 1). Without
  // this, bootstrap died on the diagnosis instead of acting on it — observed in
  // the first real run, where none of the remediation below ever executed.
  //
  // No `--json`: doctor writes JSON to stdout by default
  // (`Usage: vgpu doctor [--no-render] [--pretty]`) and rejects that flag.
  const result = await sandbox.run({ command: "npx vgpu doctor || true", workingDirectory: WORKSPACE });
  const raw = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  try {
    // The Vulkan stack prints warnings onto the same stream, so a raw
    // JSON.parse fails on exactly the unhealthy hosts worth diagnosing.
    const parsed = JSON.parse(extractJson(result.stdout ?? "")) as {
      verdict?: string;
      findings?: { probe?: string; status?: string; prescription?: unknown }[];
    };
    return { verdict: parsed.verdict ?? null, raw, findings: parsed.findings ?? [] };
  } catch {
    return { verdict: null, raw, findings: [] };
  }
}

/**
 * Remedies, in the order doctor itself recommends them.
 *
 * These are hardcoded rather than executed from doctor's `prescription` fields,
 * because those fields are PROSE, not commands. A real one reads:
 *
 *   "run: npx vgpu install-software-renderer\n
 *    Alternative (system packages): apt-get update && apt-get install -y ...\n
 *    export VK_ICD_FILENAMES=$(find /usr/share/vulkan/icd.d -name 'lvp_icd*.json' | head -1)"
 *
 * Shipping that to a shell runs `run:` as a command. Encoding the ladder here
 * keeps it executable, reviewable and free of any string a future change could
 * let the agent influence.
 */
const REMEDIES: { label: string; command: string }[] = [
  {
    label: "vgpu's portable CPU renderer (doctor's primary prescription)",
    command: "npx vgpu install-software-renderer",
  },
  {
    label: "distro Vulkan loader + Mesa ICD (doctor's 'Alternative (system packages)')",
    command:
      "apt-get update && apt-get install -y libvulkan1 libdrm2 zlib1g libzstd1 libudev1 mesa-vulkan-drivers",
  },
];

/**
 * Content key for the seed workspace (`agent/sandbox/workspace/`).
 *
 * Injected by the wrapper, which can see the real directory. The fallback is a
 * constant rather than a guess: under eve's dev runtime this module executes
 * from a snapshot, and a wrong path here would silently return the same key for
 * every workspace, which is exactly the staleness this is meant to prevent.
 */
function workspaceSeedKey(): string {
  const injected = process.env.VGPU_EVALS_WORKSPACE_KEY;
  if (injected) return injected;
  // Be loud. A constant fallback means every seed workspace hashes the same,
  // which is precisely the stale-template bug this key exists to prevent: the
  // agent silently gets the previous starter project and the run still looks
  // healthy. Reachable by invoking `eve eval` directly instead of going through
  // `pnpm agent-evals`, which is a legitimate thing to do while debugging.
  console.warn(
    "agent-evals: VGPU_EVALS_WORKSPACE_KEY is not set, so the sandbox template " +
      "cannot be invalidated when the seed workspace changes. If you edited " +
      "agent/sandbox/workspace/, run `pnpm agent-evals` (which sets it) or " +
      "`rm -rf .eve` to force a rebuild.",
  );
  return "seed-unknown";
}

export default defineSandbox({
  backend: evalSandboxBackend(),
  // Both halves matter. The tarballs key covers the vgpu under test; the
  // workspace key covers the seed files eve copies into /workspace. Without the
  // second, changing the starter project (adding a file, or removing one, as
  // the move to a bare package.json did) reuses a cached template still holding
  // the OLD workspace — the agent would then be graded on a task it was not
  // given, and nothing about the run would look wrong.
  revalidationKey: () => `${tarballsFingerprint()}-${workspaceSeedKey()}`,

  /**
   * Runs once per sandbox TEMPLATE. It installs the branch's vgpu and proves
   * the sandbox can actually render before any model is charged for a turn.
   *
   * The doctor gate is the important part: without it, "Dawn/lavapipe is broken
   * in this image" arrives as a confusing transcript in which the agent looks
   * incompetent. With it, the run stops with an infra error, once, cached.
   */
  async bootstrap({ use }) {
    const sandbox = await use();
    const manifest = readManifest();
    const dir = tarballsDir();

    await sandbox.run({ command: `mkdir -p ${TARBALL_DIR_IN_SANDBOX}` });
    for (const tarball of manifest.tarballs) {
      await sandbox.writeBinaryFile({
        path: `${TARBALL_DIR_IN_SANDBOX}/${tarball.file}`,
        content: new Uint8Array(readFileSync(join(dir, tarball.file))),
      });
    }

    // npm, not pnpm: installing a set of local tarballs whose inter-dependencies
    // must resolve to each other is exactly what a flat npm tree does well.
    // Every tarball is listed explicitly (no glob) so the command does not
    // depend on shell expansion inside the sandbox.
    const specs = manifest.tarballs.map((tarball) => `./.vgpu-tarballs/${tarball.file}`).join(" ");
    const install = await sandbox.run({
      command: `npm install --no-audit --no-fund --loglevel=error ${specs} pngjs`,
      workingDirectory: WORKSPACE,
    });
    // Belt and braces: eve throws on a non-zero exit before this runs, and its
    // wrapper error carries the command output. Kept in case that changes.
    if (install.exitCode !== 0) {
      throw new Error(
        `bootstrap: installing the branch's vgpu tarballs failed (exit ${install.exitCode}).\n${install.stderr ?? ""}`,
      );
    }

    let doctor = await runDoctor(sandbox);
    for (const remedy of REMEDIES) {
      if (doctor.verdict === "healthy") break;
      // `|| true` for the same reason as doctor: a remedy that cannot apply
      // (no apt, no network) must let the ladder continue to the next rung
      // rather than abort the whole template with eve's generic wrapper error.
      await sandbox.run({ command: `${remedy.command} || true`, workingDirectory: WORKSPACE });
      doctor = await runDoctor(sandbox);
      if (doctor.verdict === "healthy") {
        // Worth reading: it says what the base image is missing out of the box.
        process.stdout.write(`agent-evals: sandbox needed ${remedy.label}\n`);
      }
    }
    if (doctor.verdict !== "healthy") {
      throw fatal(
        `bootstrap: vgpu doctor verdict is ${JSON.stringify(doctor.verdict)}, expected "healthy" ` +
          `after applying its prescriptions. This is an INFRA failure, not a model failure — ` +
          `do not read the transcript as an agent result.\n${doctor.raw}`,
      );
    }
  },
});
