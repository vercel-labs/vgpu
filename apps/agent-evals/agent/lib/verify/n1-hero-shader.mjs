import { createHash } from "node:crypto";
import { PNG } from "pngjs";

/**
 * HARNESS-SIDE VERIFICATION FOR `n1-hero-shader`.
 *
 * Runs inside the live sandbox right after the agent's turn ends and BEFORE the
 * workspace is tarred, so the eval grades a build/serve/hover pass this code
 * performed itself rather than anything the agent claims to have run.
 *
 * The asymmetry with the agent is deliberate. This code is expected to get
 * `agent-browser` exactly right — every flag repeated on every single call,
 * because a session silently falls back to `about:blank` while still printing
 * `✓ Done` if `--executable-path` is dropped from a later command. The AGENT is
 * expected to discover that friction on its own; that discovery is what the
 * journey milestones measure. Never "help" the agent from in here.
 *
 * Nothing is thrown past step 1: a failed build means there is nothing to serve,
 * and the JSON artifact is written with whatever was reached, so the eval gates
 * on what actually happened instead of losing every signal to an exception.
 */
const WORKSPACE = "/workspace";
const ARTIFACT_DIR = `${WORKSPACE}/.agent-evals`;
const SCREENSHOT_DIR = `${ARTIFACT_DIR}/screenshots`;

/** Relative paths the eval reads out of the extracted tar. Single source of truth. */
export const N1_VERIFY_JSON = ".agent-evals/n1-verify.json";
export const N1_SCREENSHOT_DIR = ".agent-evals/screenshots";

/** Waypoints seeded into the hero markup. See the fixture's app/page.tsx. */
export const WAYPOINTS = [0, 1, 2, 3, 4];

// Inside its own container, so a fixed port cannot collide with another trial.
// (It would if the backend ever shared a network namespace across trials.)
const PORT = 4173;
const DISPLAY = ":99";
const SESSION = "n1-verify";

async function sh(sandbox, command, env) {
  // `|| true` everywhere: eve throws on a non-zero exit, and here a non-zero
  // exit is data (a build that fails, a browser that will not start), not a
  // reason to abort the hook and lose the artifact.
  const result = await sandbox.run({
    command: `${command} || true`,
    workingDirectory: WORKSPACE,
    ...(env ? { env } : {}),
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Exit code, captured explicitly because `sh` swallows it with `|| true`.
 *
 * The command runs in a SUBSHELL, `( … )`, not a group, `{ …; }`. With a group,
 * an `exit 0` inside the command (which the serve poll below uses to break out
 * of its retry loop) terminates the whole shell, so `echo __OK__` never runs and
 * a successful command is reported as a failure. That cost one real 30-minute
 * n1 run: `next start` was serving fine and this reported `serverUp: false`.
 */
async function shStatus(sandbox, command, env) {
  const result = await sh(sandbox, `( ${command} ) && echo __OK__`, env);
  return { ok: /__OK__/.test(result.stdout), ...result };
}

/**
 * Start something in the background and return immediately.
 *
 * Also a subshell, for a different reason: `sh` appends `|| true`, and
 * `cmd & || true` is a bash SYNTAX ERROR — the line never parses, so the command
 * never runs at all while `sh` reports nothing (it ignores exit codes by
 * design). That is the other half of the same lost run. `setsid` and
 * `< /dev/null` fully detach the child so tearing down this exec cannot take the
 * server or the X server with it.
 */
async function shBackground(sandbox, command, env) {
  return sh(sandbox, `( setsid nohup ${command} < /dev/null & )`, env);
}

export async function verifyN1HeroShader(sandbox) {
  const verdict = {
    buildOk: false,
    buildLog: { stderrTail: "" },
    serverUp: false,
    browserReady: false,
    screenshots: [],
    screenshotsOk: false,
    notes: [],
  };

  await sh(sandbox, `mkdir -p ${SCREENSHOT_DIR}`);

  // ---- 1. Build ---------------------------------------------------------
  const build = await shStatus(sandbox, "npx --no-install next build");
  verdict.buildOk = build.ok;
  verdict.buildLog.stderrTail = `${build.stdout}\n${build.stderr}`.trim().slice(-2000);
  if (!verdict.buildOk) {
    verdict.notes.push("next build failed; nothing to serve, so no hover pass was attempted");
    await writeVerdict(sandbox, verdict);
    return verdict;
  }

  // ---- 2. Serve ---------------------------------------------------------
  await shBackground(
    sandbox,
    `npx --no-install next start -p ${PORT} > ${ARTIFACT_DIR}/next-start.log 2>&1`,
  );
  const serve = await shStatus(
    sandbox,
    `for i in $(seq 1 60); do curl -sf http://localhost:${PORT}/ >/dev/null && exit 0; sleep 0.5; done; exit 1`,
  );
  verdict.serverUp = serve.ok;
  if (!verdict.serverUp) {
    verdict.notes.push(`next start did not answer on :${PORT} within 30s`);
    await writeVerdict(sandbox, verdict);
    return verdict;
  }

  // ---- 3. Browser ------------------------------------------------------
  // agent-browser is installed HERE, not in bootstrap, and that is the whole
  // point: pre-installing it would erase the discovery step the journey
  // milestones measure. Installing it after the turn cannot leak anything to an
  // agent that has already stopped running.
  await sh(sandbox, "npm install -g agent-browser@latest --loglevel=error");
  // Chromium comes from playwright (bootstrap pre-warmed it): Chrome for Testing
  // publishes no arm64 build, so agent-browser's own default download is not
  // usable on this image.
  const resolve = await sh(
    sandbox,
    "ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1",
  );
  const chromium = resolve.stdout.trim().split("\n")[0] ?? "";
  if (!chromium) {
    verdict.notes.push("no playwright chromium binary found under /root/.cache/ms-playwright");
    await writeVerdict(sandbox, verdict);
    return verdict;
  }
  // One X server for the whole pass. `xvfb-run` per command would tear the
  // display down between calls and kill the browser the session holds open.
  const xvfbRunning = await shStatus(sandbox, "pgrep Xvfb >/dev/null");
  if (!xvfbRunning.ok) {
    await shBackground(
      sandbox,
      `Xvfb ${DISPLAY} -screen 0 1280x800x24 > ${ARTIFACT_DIR}/xvfb.log 2>&1`,
    );
    // Give the X server a moment to create its socket: agent-browser's first
    // headed launch fails outright against a display that is not listening yet.
    await sh(sandbox, "sleep 2");
  }
  const env = { DISPLAY };

  // Every flag on every call, deliberately. Dropping any of them mid-session
  // makes agent-browser fall back to about:blank while still reporting success.
  const browser = (verb) =>
    `agent-browser --executable-path ${chromium} --args '--no-sandbox' --session ${SESSION} --webgpu --headed ${verb}`;

  const opened = await shStatus(sandbox, browser(`open http://localhost:${PORT}/`), env);
  verdict.browserReady = opened.ok;
  if (!verdict.browserReady) {
    verdict.notes.push(`agent-browser could not open the page: ${opened.stderr.slice(-500)}`);
    await writeVerdict(sandbox, verdict);
    return verdict;
  }
  // Let the first frames render before the baseline capture, so "before" is a
  // live canvas rather than an empty one.
  await sh(sandbox, browser("wait 2000"), env);

  for (const waypoint of WAYPOINTS) {
    const selector = `'[data-testid="n1-wp-${waypoint}"]'`;
    await sh(sandbox, browser(`hover ${selector}`), env);
    // A beat between hover and capture: a trail that fades over time needs the
    // frame after the pointer moved, not the one during the move.
    await sh(sandbox, browser("wait 400"), env);
    const path = `${SCREENSHOT_DIR}/wp-${waypoint}.png`;
    await sh(sandbox, browser(`screenshot ${path}`), env);

    const bytes = await sandbox.readBinaryFile({ path }).catch(() => null);
    const entry = { waypoint, path: `${N1_SCREENSHOT_DIR}/wp-${waypoint}.png` };
    if (!bytes) {
      entry.decoded = false;
      verdict.screenshots.push(entry);
      continue;
    }
    const buffer = Buffer.from(bytes);
    entry.sha256 = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    try {
      const png = PNG.sync.read(buffer);
      entry.decoded = true;
      entry.width = png.width;
      entry.height = png.height;
      // vgpu's own browser guide uses this heuristic: a near-zero luma spread is
      // a blank or black capture. Logged, not gated, in v0.
      entry.lumaStdDev = Number(lumaStdDev(png).toFixed(2));
    } catch (error) {
      entry.decoded = false;
      entry.error = String(error).slice(0, 200);
    }
    verdict.screenshots.push(entry);
  }

  await sh(sandbox, browser("close"), env);

  const decoded = verdict.screenshots.filter((entry) => entry.decoded);
  const hashes = new Set(decoded.map((entry) => entry.sha256));
  // Two conditions, both necessary: every capture is a real PNG, and no two are
  // byte-identical. Identical captures mean the pointer changed nothing.
  verdict.screenshotsOk = decoded.length === WAYPOINTS.length && hashes.size === WAYPOINTS.length;
  if (!verdict.screenshotsOk) {
    verdict.notes.push(
      `decoded ${decoded.length}/${WAYPOINTS.length} screenshots, ${hashes.size} distinct`,
    );
  }

  await writeVerdict(sandbox, verdict);
  return verdict;
}

function lumaStdDev(png) {
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const luma =
      0.2126 * png.data[index] + 0.7152 * png.data[index + 1] + 0.0722 * png.data[index + 2];
    sum += luma;
    sumSquares += luma * luma;
    count += 1;
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
}

async function writeVerdict(sandbox, verdict) {
  // Written into the workspace so it travels out in the same tar as the
  // screenshots — one artifact set, one export, no second channel to keep in
  // sync.
  await sandbox.writeTextFile({
    path: `${ARTIFACT_DIR}/n1-verify.json`,
    content: JSON.stringify(verdict, null, 2),
  });
}
