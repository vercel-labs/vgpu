import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineSandbox } from "eve/sandbox";
import type { SandboxSession } from "eve/sandbox";
import { extractJson } from "../lib/extract-json.ts";
import { tarballsDir } from "../lib/paths.ts";
import { evalSandboxBackend } from "./backend.ts";

const WORKSPACE = "/workspace";
const TARBALL_DIR_IN_SANDBOX = `${WORKSPACE}/.vgpu-tarballs`;

interface TarballManifest {
  packedAt: string;
  gitSha: string;
  gitBranch: string;
  tarballs: { name: string; version: string; file: string }[];
}

function readManifest(): TarballManifest {
  const dir = tarballsDir();
  const manifestPath = join(dir, "tarballs.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `bootstrap: no vgpu tarballs found at ${dir}.\n` +
        "  This tool installs the vgpu built from the CURRENT BRANCH, not the one on npm.\n" +
        "  Run `pnpm agent-evals` (which packs first) or `pnpm --filter @vgpu/agent-evals pack-vgpu`.",
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as TarballManifest;
}

/**
 * Template cache key. It must change whenever the packed bytes change,
 * otherwise a rebuilt branch is graded against a cached sandbox holding the
 * PREVIOUS build — the single most expensive way to be wrong here, because
 * everything still looks like it worked.
 *
 * Content-addressed rather than timestamp-based, so re-packing an unchanged
 * tree keeps the cache warm.
 */
function tarballsFingerprint(): string {
  const dir = tarballsDir();
  if (!existsSync(dir)) return "no-tarballs";
  const hash = createHash("sha256");
  for (const file of readdirSync(dir).sort()) {
    hash.update(file);
    hash.update(readFileSync(join(dir, file)));
  }
  return `vgpu-tarballs-${hash.digest("hex").slice(0, 16)}`;
}

interface DoctorReport {
  verdict: string | null;
  raw: string;
  findings: { probe?: string; status?: string; prescription?: unknown }[];
}

async function runDoctor(sandbox: SandboxSession): Promise<DoctorReport> {
  // No `--json`: vgpu's doctor writes JSON to stdout by default
  // (`Usage: vgpu doctor [--no-render] [--pretty]`) and rejects `--json`.
  const result = await sandbox.run({ command: "npx vgpu doctor", workingDirectory: WORKSPACE });
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
 * What to run when doctor is unhealthy.
 *
 * Prefer what doctor itself prescribes — it knows which probe failed — and fall
 * back to the backend's known remedy. Kept backend-agnostic apart from that one
 * branch, so flipping VGPU_EVALS_SANDBOX stays a one-line change.
 */
function prescriptionsFor(report: DoctorReport): string[] {
  const fromDoctor = report.findings
    .filter((finding) => finding.status !== "ok" && finding.status !== "skip")
    .flatMap((finding) => (Array.isArray(finding.prescription) ? finding.prescription : [finding.prescription]))
    .filter((value): value is string => typeof value === "string" && value.trim() !== "");

  if (fromDoctor.length > 0) return fromDoctor;

  // Both backends boot the same Debian-based eve image, so the remedy is the
  // same: vgpu ships a portable, sha256-verified CPU renderer for exactly this.
  // (The `sudo dnf install -y mesa-vulkan-drivers vulkan-loader` from the Vercel
  // Sandbox spike applies to the AL2023 STOCK runtimes, which eve does not use.)
  return ["npx vgpu install-software-renderer"];
}

export default defineSandbox({
  backend: evalSandboxBackend(),
  revalidationKey: () => tarballsFingerprint(),

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
    if (install.exitCode !== 0) {
      throw new Error(
        `bootstrap: installing the branch's vgpu tarballs failed (exit ${install.exitCode}).\n${install.stderr ?? ""}`,
      );
    }

    let doctor = await runDoctor(sandbox);
    if (doctor.verdict !== "healthy") {
      for (const command of prescriptionsFor(doctor)) {
        await sandbox.run({ command, workingDirectory: WORKSPACE });
      }
      doctor = await runDoctor(sandbox);
    }
    if (doctor.verdict !== "healthy") {
      throw new Error(
        `bootstrap: vgpu doctor verdict is ${JSON.stringify(doctor.verdict)}, expected "healthy" ` +
          `after applying its prescriptions. This is an INFRA failure, not a model failure — ` +
          `do not read the transcript as an agent result.\n${doctor.raw}`,
      );
    }
  },
});
