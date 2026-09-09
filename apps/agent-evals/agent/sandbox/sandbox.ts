import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineSandbox } from "eve/sandbox";
import type { SandboxSession } from "eve/sandbox";
// Plain .mjs on purpose: the pack script must run with bare `node` before
// anything in this workspace is built. Importing it here (rather than copying
// the key derivation) keeps packer and consumer from ever disagreeing.
import { sourceKey } from "../../scripts/pack-vgpu.mjs";
import { extractJson } from "../lib/extract-json.ts";
import { tarballsDir, taskSeedDir } from "../lib/paths.ts";
import { requireTaskId } from "../lib/task.ts";
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
    command: asRoot(
      "apt-get update && apt-get install -y libvulkan1 libdrm2 zlib1g libzstd1 libudev1 mesa-vulkan-drivers",
    ),
  },
];

/**
 * Runs a package-manager command as root whether or not the sandbox user is.
 *
 * `ghcr.io/vercel/eve:latest` is a floating tag, and the revision published on
 * 2026-09-03 switched the container user from root to `vercel-sandbox` (uid
 * 1001, passwordless sudo). Every bare `apt-get` here then failed with
 * "Permission denied", the `|| true` that keeps the remedy ladder moving
 * swallowed it, and bootstrap ended on an honest but misleading "doctor is
 * unhealthy after applying its prescriptions" — the prescriptions had never
 * applied. `sudo -n` (never prompt) keeps a missing sudo or a password prompt
 * a loud failure instead of a hang.
 *
 * `command` must not contain single quotes; every caller passes a literal.
 */
function asRoot(command: string): string {
  if (command.includes("'")) throw new Error(`asRoot: command must not contain single quotes: ${command}`);
  return `if [ "$(id -u)" = 0 ]; then ${command}; else sudo -n sh -c '${command}'; fi`;
}

/**
 * Content key for the RUNNING TASK's seed tree (`agent/sandbox/tasks/<id>/`).
 *
 * Injected by the wrapper, which can see the real directory. The fallback is a
 * constant rather than a guess: under eve's dev runtime this module executes
 * from a snapshot, and a wrong path here would silently return the same key for
 * every task, which is exactly the staleness this is meant to prevent.
 */
function taskSeedFingerprint(): string {
  const injected = process.env.VGPU_EVALS_TASK_SEED_KEY;
  if (injected) return injected;
  // Be loud. A constant fallback means every seed tree hashes the same, which is
  // precisely the stale-template bug this key exists to prevent: the agent
  // silently gets the previous starter project and the run still looks healthy.
  // Reachable by invoking `eve eval` directly instead of going through
  // `pnpm agent-evals`, which is a legitimate thing to do while debugging.
  console.warn(
    "agent-evals: VGPU_EVALS_TASK_SEED_KEY is not set, so the sandbox template " +
      "cannot be invalidated when a task's seed files change. If you edited " +
      "agent/sandbox/tasks/, run `pnpm agent-evals --task <id>` (which sets it) " +
      "or `rm -rf .eve` to force a rebuild.",
  );
  return "task-seed-unknown";
}

/**
 * Copies one task's seed tree into /workspace, file by file.
 *
 * This replaces eve's own `agent/sandbox/workspace/` convention, which is a
 * single fixed slot ("At most one entry per agent; mounted.") and therefore
 * cannot express "one of several seeds, chosen at run time". Same mechanism the
 * tarball step already uses, just generalized.
 *
 * Every seed file across the current tasks is text. A future binary seed asset
 * needs `writeBinaryFile` behind an extension allowlist; it is not guessed here,
 * because silently writing a PNG through a text write would corrupt it.
 */
async function seedTaskWorkspace(sandbox: SandboxSession, taskId: string): Promise<number> {
  const root = taskSeedDir(taskId);
  if (!existsSync(root)) {
    throw fatal(
      `bootstrap: task "${taskId}" has no seed directory at ${root}.\n` +
        "  Every task needs one, even if it only holds a package.json.",
    );
  }
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  for (const file of files) {
    await sandbox.writeTextFile({
      path: `${WORKSPACE}/${relative(root, file).split(sep).join("/")}`,
      content: readFileSync(file, "utf8"),
    });
  }
  return files.length;
}

/**
 * Extra bootstrap work for one specific task, cached in its template.
 *
 * The split is deliberate: cache what is SLOW and invisible to the docs, leave
 * everything fast and documented for the agent to discover and run itself.
 * Chromium is ~110 MB and several minutes, and vgpu's own browser guide never
 * mentions that Chrome for Testing has no arm64 build — so it is pre-warmed
 * here. `agent-browser` itself is NOT installed: it is the literal first command
 * in that guide, it takes seconds, and installing it would erase the discovery
 * step the journey milestones exist to measure.
 */
const TASK_EXTRAS: Record<string, { label: string; command: string }[]> = {
  "n1-hero-shader": [
    {
      label: "browser runtime libraries (Vulkan loader, Mesa, virtual X server)",
      command: asRoot("apt-get update && apt-get install -y libvulkan1 mesa-vulkan-drivers xvfb xauth"),
    },
    {
      // PR #272 review (P1-9): `curl`, `pgrep` and `setsid` are behind hard
      // gates in `agent/lib/verify/n1-hero-shader.mjs` — `curl` polls the
      // served port and now also checks the per-run nonce, `pgrep` waits for
      // Xvfb, `setsid` detaches `next start`/`Xvfb` — but were declared
      // nowhere. They happen to ship in today's `ghcr.io/vercel/eve:latest`
      // (measured with `command -v`), which is a floating tag: a future
      // revision that drops one of them would silently turn `serverUp`/
      // `browserReady` into infra regressions reported as agent failures,
      // after a full 30-minute turn, with nothing here that would have
      // caught it first. Unlike `xvfb`/`xauth` above, these ARE present on
      // the base image today, so this line is a declaration of a real
      // dependency, not a workaround for a real gap.
      label: "verify-pass dependencies (curl for the port/nonce poll, pgrep/setsid for process control)",
      command: asRoot("apt-get update && apt-get install -y curl procps util-linux"),
    },
    {
      label: "playwright's chromium + its system libraries (Chrome for Testing publishes no arm64 build)",
      // `--with-deps` is load-bearing, not belt-and-braces: the bare
      // `playwright install chromium` downloads a browser that cannot start on
      // this image at all — `libglib-2.0.so.0: cannot open shared object file`,
      // exit 127 before Chrome ever writes a DevTools port. The apt line above
      // covers the Vulkan/X side, not Chromium's own GTK/ATK/NSS closure, and
      // `--with-deps` is playwright's own maintained list of exactly those.
      command: "npm install -g playwright && npx playwright install --with-deps chromium",
    },
  ],
  // A fresh random image per run, so the smoke test cannot be passed by guessing
  // the two most likely demo colours. Same palette as eve's own render-stripes
  // fixture: single-token names no model paraphrases (unlike cyan/teal).
  "view-image-smoke": [
    {
      label: "a randomized known.png for the view-image smoke test",
      command:
        "node -e \"const {PNG}=require('pngjs');const fs=require('fs');" +
        "const P={black:[0,0,0],blue:[0,0,255],green:[0,160,0],orange:[255,140,0],red:[255,0,0],yellow:[255,220,0]};" +
        "const n=Object.keys(P);const a=n[Math.floor(Math.random()*n.length)];" +
        "let b=a;while(b===a){b=n[Math.floor(Math.random()*n.length)];}" +
        "const s=64;const p=new PNG({width:s,height:s});" +
        "for(let y=0;y<s;y++){for(let x=0;x<s;x++){const c=P[x<s/2?a:b];const i=(y*s+x)*4;" +
        "p.data[i]=c[0];p.data[i+1]=c[1];p.data[i+2]=c[2];p.data[i+3]=255;}}" +
        "fs.writeFileSync('known.png',PNG.sync.write(p));\"",
    },
  ],
};

export default defineSandbox({
  backend: evalSandboxBackend(),
  // All three parts matter. The tarballs key covers the vgpu under test; the
  // task id and its seed hash cover WHICH starter project and WHAT is in it.
  // Without the seed half, changing a starter project reuses a cached template
  // still holding the old one — the agent is then graded on a task it was not
  // given, and nothing about the run looks wrong. Without the task id, two
  // tasks with different seeds would fight over one cache entry, and warming
  // n1's expensive template would invalidate s2's.
  revalidationKey: () => `${tarballsFingerprint()}-${requireTaskId()}-${taskSeedFingerprint()}`,

  /**
   * Runs once per sandbox TEMPLATE. It installs the branch's vgpu and proves
   * the sandbox can actually render before any model is charged for a turn.
   *
   * The doctor gate is the important part: without it, "Dawn/lavapipe is broken
   * in this image" arrives as a confusing transcript in which the agent looks
   * incompetent. With it, the run stops with an infra error, once, cached.
   */
  async bootstrap({ use }) {
    // Before any time is spent: which task is this? An unset VGPU_EVALS_TASK is
    // a usage error, and finding out after a two-minute install is worse.
    const taskId = requireTaskId();
    const sandbox = await use();
    const manifest = readManifest();
    const dir = tarballsDir();

    // Seed BEFORE installing, not after.
    //
    // `npm install` prunes packages the package.json on disk does not declare.
    // Seeding after the tarball install would drop the task's package.json over
    // the one npm just wrote, and the next install would delete the branch's
    // vgpu as extraneous — the suite would then grade an agent that has no vgpu
    // at all. Seeding first means one install resolves the tarballs AND whatever
    // the task itself declares.
    const seeded = await seedTaskWorkspace(sandbox, taskId);
    process.stdout.write(`agent-evals: seeded ${seeded} file(s) for task ${taskId}\n`);

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

    // A second, argument-less install. The command above already completes the
    // tree from package.json, so this is a cheap reconcile — but it is what
    // keeps extra dependencies DATA-DRIVEN: a task declares `next`/`react` in
    // its own seed package.json and no per-task package list ever appears here.
    await sandbox.run({
      command: "npm install --no-audit --no-fund --loglevel=error",
      workingDirectory: WORKSPACE,
    });

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

    // Per-task extras last: they are only worth their minutes once the sandbox
    // is known to render at all.
    for (const extra of TASK_EXTRAS[taskId] ?? []) {
      // `|| true` for the same reason as the remedies above — a pre-warm that
      // cannot apply must not abort the template, which eve would then retry
      // four times over.
      const result = await sandbox.run({
        command: `${extra.command} || true`,
        workingDirectory: WORKSPACE,
      });
      process.stdout.write(`agent-evals: pre-warmed ${extra.label} (exit ${result.exitCode})\n`);
    }
  },
});
