// @ts-check

/**
 * HARNESS-SIDE VERIFICATION FOR THE `n2-ship-hero` / `n3-explore-hero` PAIR.
 *
 * Runs inside the live sandbox right after the agent's turn ends and BEFORE the
 * workspace is tarred. It answers two questions the eval must not take on the
 * agent's word: does the app still build, and does every shipped WGSL module
 * still pass `vgpu check`. No browser, no server: these two tasks are about
 * what the agent does at the finishing moment, not about pixels, and keeping
 * the verify pass to a build keeps each run to minutes instead of n1's half
 * hour.
 *
 * Same rules as `n1-hero-shader.mjs`, in short form:
 * - exit codes decide success, never a substring of agent-influenced stdout;
 * - nothing throws past this module — `writeVerdict` runs in a `finally`, so a
 *   losing agent cannot convert a real failure into a reported infra failure by
 *   breaking its own workspace;
 * - every non-literal value spliced into a command goes through `shellQuote`
 *   (the WGSL file list is discovered under a directory the agent controlled).
 */
const WORKSPACE = "/workspace";
const ARTIFACT_DIR = `${WORKSPACE}/.agent-evals`;

/** Relative path the eval reads out of the extracted tar. Single source of truth. */
export const BUILD_VERIFY_JSON = ".agent-evals/build-verify.json";

/** Directories `find` must not descend into when listing shipped WGSL. */
const FIND_PRUNE = ["node_modules", ".next", ".git", ".vgpu-tarballs", ".agent-evals"];

/**
 * @typedef {Object} WgslCheck
 * @property {string} file - workspace-relative path
 * @property {boolean} ok - `vgpu check` exited 0
 * @property {string} tail - last 600 chars of combined output, for the log
 */

/**
 * @typedef {Object} BuildVerdict
 * @property {boolean} buildOk
 * @property {{stderrTail: string}} buildLog
 * @property {WgslCheck[]} wgsl
 * @property {boolean} wgslOk - every discovered module passed; also true when none exist
 * @property {string[]} notes
 */

/**
 * POSIX single-quote escaping: the only safe way to splice an untrusted string
 * into a shell command. Same helper as n1's, kept local so this module stays
 * importable on its own.
 * @param {string} value
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {any} sandbox
 * @param {string} command
 */
async function sh(sandbox, command) {
  const result = await sandbox.run({ command, workingDirectory: WORKSPACE });
  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** @param {any} sandbox */
export async function verifyNextBuild(sandbox) {
  /** @type {BuildVerdict} */
  const verdict = {
    buildOk: false,
    buildLog: { stderrTail: "" },
    wgsl: [],
    wgslOk: false,
    notes: [],
  };

  try {
    // ---- 0. Artifact dir. An agent that replaced `.agent-evals` with a plain
    // file would make every later write throw ENOTDIR; clear exactly that case.
    const prep = await sh(
      sandbox,
      `if [ -e ${shellQuote(ARTIFACT_DIR)} ] && [ ! -d ${shellQuote(ARTIFACT_DIR)} ]; then rm -f ${shellQuote(ARTIFACT_DIR)}; fi && mkdir -p ${shellQuote(ARTIFACT_DIR)}`,
    );
    if (prep.exitCode !== 0) {
      verdict.notes.push(`could not prepare ${ARTIFACT_DIR} (exit ${prep.exitCode}): ${prep.stderr.slice(-300)}`);
    }

    // ---- 1. WGSL modules, discovered by the harness rather than listed by the
    // agent. Paths come back one per line, NUL-free by construction of `find
    // -print` on a tree we seeded; anything odd is quoted below anyway.
    const prune = FIND_PRUNE.map((dir) => `-name ${shellQuote(dir)} -prune`).join(" -o ");
    const list = await sh(sandbox, `find . \\( ${prune} \\) -o -type f -name '*.wgsl' -print`);
    const files = list.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^\.\//, ""))
      .sort();
    if (list.exitCode !== 0) {
      verdict.notes.push(`find for *.wgsl exited ${list.exitCode}: ${list.stderr.slice(-300)}`);
    }
    for (const file of files) {
      const check = await sh(sandbox, `npx --no-install vgpu check ${shellQuote(file)}`);
      verdict.wgsl.push({
        file,
        ok: check.exitCode === 0,
        tail: `${check.stdout}\n${check.stderr}`.trim().slice(-600),
      });
    }
    verdict.wgslOk = verdict.wgsl.every((entry) => entry.ok);
    if (files.length === 0) verdict.notes.push("no .wgsl modules found in the workspace");

    // ---- 2. Build.
    const build = await sh(sandbox, "npx --no-install next build");
    verdict.buildOk = build.exitCode === 0;
    verdict.buildLog.stderrTail = `${build.stdout}\n${build.stderr}`.trim().slice(-2000);
    if (!verdict.buildOk) verdict.notes.push(`next build exited ${build.exitCode}`);
  } catch (error) {
    verdict.notes.push(`verify threw: ${String(error).slice(0, 300)}`);
  } finally {
    await writeVerdict(sandbox, verdict);
  }
  return verdict;
}

/**
 * @param {any} sandbox
 * @param {BuildVerdict} verdict
 */
async function writeVerdict(sandbox, verdict) {
  const path = `${WORKSPACE}/${BUILD_VERIFY_JSON}`;
  try {
    await sandbox.writeTextFile({ path, content: JSON.stringify(verdict, null, 2) });
  } catch (error) {
    verdict.notes.push(`writeVerdict: first attempt failed (${String(error).slice(0, 200)}), retrying once`);
    try {
      await sh(sandbox, `rm -rf ${shellQuote(ARTIFACT_DIR)} && mkdir -p ${shellQuote(ARTIFACT_DIR)}`);
      await sandbox.writeTextFile({ path, content: JSON.stringify(verdict, null, 2) });
    } catch (retryError) {
      // eslint-disable-next-line no-console
      console.error(`[next-build verify] could not write ${path} after retry: ${String(retryError)}`);
    }
  }
}
