// @ts-check
import { createHash, randomBytes, randomInt } from "node:crypto";
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
 * Nothing throws past this module's boundary: the whole body runs inside a
 * try/catch and `writeVerdict` always runs in a `finally`, so a losing agent
 * cannot turn a real failure into a reported "infra failure" by corrupting its
 * own workspace (PR #272 review, P1-5) — the exception is recorded as a note on
 * an honest, still-false verdict instead of escaping the hook.
 *
 * Gate-integrity notes (PR #272 review, P0-1/P0-2/P1-2/P1-3):
 * - Every "did the command succeed" question is answered with the sandbox's own
 *   `exitCode`, never a string the command's own (agent-influenced) stdout
 *   happens to contain. There used to be an unanchored `__OK__` substring
 *   marker here; it is gone, along with the `|| true` that made it necessary
 *   (eve's hook-time sandbox session does not throw on a non-zero exit — see
 *   `buildSandboxSession.run` in eve@0.29.5's dist — so nothing was ever bought
 *   by discarding the exit code in the first place).
 * - `next start` is served on a per-run random high port, not the fixed 4173,
 *   and is only trusted once it serves back a per-run random nonce this module
 *   writes into the workspace's `public/` directory before building. A foreign
 *   process the agent leaves listening on a well-known port cannot know either
 *   the port or the nonce in advance, because both are generated after the
 *   agent's turn has already ended. The server's captured pid is also checked
 *   for liveness before its response is trusted.
 * - Every value that did not originate as a literal string constant in this
 *   file is passed through `shellQuote` before being spliced into a command
 *   string (the chromium binary path is resolved from a glob under
 *   `/root/.cache`, a directory the agent controls as root during its turn).
 */
const WORKSPACE = "/workspace";
const ARTIFACT_DIR = `${WORKSPACE}/.agent-evals`;
const SCREENSHOT_DIR = `${ARTIFACT_DIR}/screenshots`;
const PID_FILE = `${ARTIFACT_DIR}/next-start.pid`;
const NEXT_START_LOG = `${ARTIFACT_DIR}/next-start.log`;

/** Relative paths the eval reads out of the extracted tar. Single source of truth. */
export const N1_VERIFY_JSON = ".agent-evals/n1-verify.json";
export const N1_SCREENSHOT_DIR = ".agent-evals/screenshots";

/** Waypoints seeded into the hero markup. See the fixture's app/page.tsx. */
export const WAYPOINTS = [0, 1, 2, 3, 4];

const DISPLAY = ":99";
const SESSION = "n1-verify";

/** Chromium is resolved via a shell glob under an agent-writable directory. */
const CHROMIUM_PATTERN = /^\/root\/\.cache\/ms-playwright\/chromium-[0-9]+\/chrome-linux\/chrome$/;

/**
 * @typedef {Object} N1ScreenshotEntry
 * @property {number} waypoint
 * @property {string} path
 * @property {boolean} hoverOk - `agent-browser hover` reported success (exit
 *   code 0 AND a "✓" in stdout) for this waypoint's selector.
 * @property {boolean} decoded
 * @property {string} [sha256]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [lumaStdDev]
 * @property {string} [error]
 */

/**
 * @typedef {Object} N1Verdict
 * @property {boolean} buildOk
 * @property {{stderrTail: string}} buildLog
 * @property {boolean} serverUp
 * @property {boolean} browserReady
 * @property {N1ScreenshotEntry[]} screenshots
 * @property {boolean} screenshotsOk
 * @property {boolean} hoverOk - aggregate: true only if every waypoint's hover
 *   was reported ok. Previously computed per-entry and then dropped before it
 *   reached the eval (PR #272 review, P1-6); this field is the fix — one
 *   boolean lane 3 can log and gate on without also needing to know about
 *   `screenshots[].hoverOk`.
 * @property {string[]} notes
 */

/**
 * Mirrors eve's internal `execution/sandbox/shell-quote.js`, which is not part
 * of eve's public export surface (only `eve/sandbox` is), so it is duplicated
 * here rather than imported. Every interpolated path or argument that is not a
 * literal string constant in this file goes through this before it is spliced
 * into a command string.
 * @param {string} value
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Runs a command in the sandbox and returns its real exit code. No `|| true`,
 * no completion marker: eve's hook-time sandbox session (`ctx.getSandbox()`)
 * does not throw on a non-zero exit — verified directly against the pinned
 * `eve@0.29.5` dist (`buildSandboxSession.run` in
 * `dist/src/execution/sandbox/session.js` just returns `{exitCode, stdout,
 * stderr}`; the throw-on-`exitCode===1` wrapper in `logging-session.js` is
 * applied only to the bootstrap-time session, never to this one) — so the exit
 * code is trustworthy data, not something that needs to be smuggled through
 * stdout.
 * @param {any} sandbox
 * @param {string} command
 * @param {Record<string,string>} [env]
 */
async function sh(sandbox, command, env) {
  const result = await sandbox.run({
    command,
    workingDirectory: WORKSPACE,
    ...(env ? { env } : {}),
  });
  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Starts a detached background process and captures its pid, so a later step
 * can check the process is still alive rather than trusting a port response on
 * faith. `setsid`/`nohup`/`< /dev/null` fully detach the child so tearing down
 * this exec cannot take the server or the X server with it; `echo $!` after
 * the `&` captures the immediate child's pid into a file inside the workspace.
 * @param {any} sandbox
 * @param {string} command
 * @param {string} pidFile
 * @param {Record<string,string>} [env]
 */
async function startBackground(sandbox, command, pidFile, env) {
  return sh(sandbox, `( setsid nohup ${command} < /dev/null & echo $! > ${shellQuote(pidFile)} )`, env);
}

/** @param {any} sandbox */
export async function verifyN1HeroShader(sandbox) {
  /** @type {N1Verdict} */
  const verdict = {
    buildOk: false,
    buildLog: { stderrTail: "" },
    serverUp: false,
    browserReady: false,
    screenshots: [],
    screenshotsOk: false,
    hoverOk: false,
    notes: [],
  };

  try {
    // ---- 0. Prepare artifact dir -----------------------------------------
    // An agent that knows it is losing can replace `.agent-evals` with a
    // plain file so every later write throws ENOTDIR and the run gets
    // reported as harness breakage instead of a loss (PR #272 review, P1-5).
    // Detect and clear exactly that case up front. Also wipe any screenshots
    // left over from earlier in the agent's own turn, so a stale PNG can
    // never survive into what looks like a harness-captured set.
    const prep = await sh(
      sandbox,
      [
        `if [ -e ${shellQuote(ARTIFACT_DIR)} ] && [ ! -d ${shellQuote(ARTIFACT_DIR)} ]; then rm -f ${shellQuote(ARTIFACT_DIR)}; fi`,
        `rm -rf ${shellQuote(SCREENSHOT_DIR)}`,
        `mkdir -p ${shellQuote(SCREENSHOT_DIR)}`,
      ].join(" && "),
    );
    if (prep.exitCode !== 0) {
      verdict.notes.push(
        `could not prepare ${ARTIFACT_DIR} for writing (exit ${prep.exitCode}): ` +
          `${prep.stderr.slice(-300)} — continuing anyway; later steps that need it will ` +
          `fail and be reported as such, not thrown`,
      );
    }

    // ---- 1. Nonce, so "the thing on the port is the thing built this run"
    // is proven rather than assumed. Generated only now, after the agent's
    // turn has already ended, so nothing the agent left behind can know it.
    const nonce = randomBytes(24).toString("hex");
    const nonceRelPath = "public/n1-verify-nonce.txt";
    const nonceUrlPath = "/n1-verify-nonce.txt";
    await sandbox.writeTextFile({ path: `${WORKSPACE}/${nonceRelPath}`, content: nonce });

    // ---- 2. Build ----------------------------------------------------------
    const build = await sh(sandbox, "npx --no-install next build");
    verdict.buildOk = build.exitCode === 0;
    verdict.buildLog.stderrTail = `${build.stdout}\n${build.stderr}`.trim().slice(-2000);
    if (!verdict.buildOk) {
      verdict.notes.push("next build failed; nothing to serve, so no hover pass was attempted");
      return verdict;
    }

    // ---- 3. Serve ------------------------------------------------------
    // A random high port per run, not the fixed 4173: a foreign server the
    // agent leaves listening on a well-known port cannot pre-bind a port it
    // does not know is coming (PR #272 review, P0-2).
    const port = randomInt(20000, 60000);
    await sh(sandbox, `rm -f ${shellQuote(PID_FILE)} ${shellQuote(NEXT_START_LOG)}`);
    await startBackground(
      sandbox,
      `npx --no-install next start -p ${port} > ${shellQuote(NEXT_START_LOG)} 2>&1`,
      PID_FILE,
    );
    // Poll until the server answers the per-run nonce path with the exact
    // nonce AND the pid this run captured is still alive. Both conditions are
    // required: a squatter cannot know the nonce, and a dead pid means
    // whatever answered is not the process this run started.
    const pollScript = [
      `for i in $(seq 1 60); do`,
      `  body="$(curl -sf http://localhost:${port}${nonceUrlPath} 2>/dev/null)"`,
      `  pid="$(cat ${shellQuote(PID_FILE)} 2>/dev/null)"`,
      `  if [ "$body" = ${shellQuote(nonce)} ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then exit 0; fi`,
      `  sleep 0.5`,
      `done`,
      `exit 1`,
    ].join("\n");
    const serve = await sh(sandbox, pollScript);
    verdict.serverUp = serve.exitCode === 0;
    if (!verdict.serverUp) {
      const log = await sh(sandbox, `tail -c 2000 ${shellQuote(NEXT_START_LOG)} 2>/dev/null`);
      const addrInUse = /EADDRINUSE/.test(log.stdout) || /EADDRINUSE/.test(log.stderr);
      verdict.notes.push(
        addrInUse
          ? `port ${port} was already bound by another process when next start tried to ` +
              `listen (EADDRINUSE) — likely a foreign/leftover server; treated as a failed ` +
              `serve, not a pass`
          : `next start never served the per-run nonce at :${port}${nonceUrlPath} from a live ` +
              `pid within 30s (log tail: ${log.stdout.slice(-300)})`,
      );
      return verdict;
    }

    // ---- 4. Browser ------------------------------------------------------
    // agent-browser is installed HERE, not in bootstrap, and that is the whole
    // point: pre-installing it would erase the discovery step the journey
    // milestones measure. Installing it after the turn cannot leak anything to an
    // agent that has already stopped running.
    const install = await sh(sandbox, "npm install -g agent-browser@latest --loglevel=error");
    if (install.exitCode !== 0) {
      verdict.notes.push(
        `npm install -g agent-browser failed (exit ${install.exitCode}): ${install.stderr.slice(-300)}`,
      );
      return verdict;
    }
    // Chromium comes from playwright (bootstrap pre-warmed it): Chrome for Testing
    // publishes no arm64 build, so agent-browser's own default download is not
    // usable on this image.
    const resolve = await sh(
      sandbox,
      "ls -d /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1",
    );
    const chromiumRaw = resolve.stdout.trim().split("\n")[0] ?? "";
    if (!chromiumRaw || !CHROMIUM_PATTERN.test(chromiumRaw)) {
      // The agent has root during its own turn and this path is resolved from
      // a glob under a directory it controls: refuse anything that does not
      // match the exact shape a real playwright install produces (PR #272
      // review, P1-3), rather than trusting `ls | head -1` blindly.
      verdict.notes.push(
        chromiumRaw
          ? `resolved chromium path failed validation, refusing to use it: ${JSON.stringify(chromiumRaw).slice(0, 200)}`
          : "no playwright chromium binary found under /root/.cache/ms-playwright",
      );
      return verdict;
    }
    const chromium = chromiumRaw;
    // One X server for the whole pass. `xvfb-run` per command would tear the
    // display down between calls and kill the browser the session holds open.
    const xvfbRunning = await sh(sandbox, "pgrep Xvfb >/dev/null");
    if (xvfbRunning.exitCode !== 0) {
      await startBackground(
        sandbox,
        `Xvfb ${DISPLAY} -screen 0 1280x800x24 > ${shellQuote(`${ARTIFACT_DIR}/xvfb.log`)} 2>&1`,
        `${ARTIFACT_DIR}/xvfb.pid`,
      );
      // Give the X server a moment to create its socket: agent-browser's first
      // headed launch fails outright against a display that is not listening yet.
      await sh(sandbox, "sleep 2");
    }
    const env = { DISPLAY };

    // Every flag on every call, deliberately. Dropping any of them mid-session
    // makes agent-browser fall back to about:blank while still reporting success.
    /** @type {(verb: string) => string} */
    const browser = (verb) =>
      `agent-browser --executable-path ${shellQuote(chromium)} --args '--no-sandbox' --session ${SESSION} --webgpu --headed ${verb}`;

    const opened = await sh(sandbox, browser(`open http://localhost:${port}/`), env);
    verdict.browserReady = opened.exitCode === 0;
    if (!verdict.browserReady) {
      verdict.notes.push(`agent-browser could not open the page: ${opened.stderr.slice(-500)}`);
      return verdict;
    }
    // Let the first frames render before the baseline capture, so "before" is a
    // live canvas rather than an empty one.
    await sh(sandbox, browser("wait 2000"), env);

    for (const waypoint of WAYPOINTS) {
      const selector = shellQuote(`[data-testid="n1-wp-${waypoint}"]`);
      // Recorded per waypoint: a hover that silently missed its target looks
      // exactly like a shader that ignores the pointer once the captures are all
      // that is left. Both the exit code AND agent-browser's own "✓ Done" text
      // are checked — the exit code alone does not rule out a session that
      // quietly fell back to about:blank while still reporting success.
      const hover = await sh(sandbox, browser(`hover ${selector}`), env);
      const hoverOk = hover.exitCode === 0 && /✓/.test(hover.stdout);
      // A beat between hover and capture: a trail that fades over time needs the
      // frame after the pointer moved, not the one during the move.
      await sh(sandbox, browser("wait 400"), env);
      const path = `${SCREENSHOT_DIR}/wp-${waypoint}.png`;
      await sh(sandbox, browser(`screenshot ${shellQuote(path)}`), env);

      const bytes = await sandbox.readBinaryFile({ path }).catch(() => null);
      /** @type {N1ScreenshotEntry} */
      const entry = {
        waypoint,
        path: `${N1_SCREENSHOT_DIR}/wp-${waypoint}.png`,
        hoverOk,
        decoded: false,
      };
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
    // Aggregate, so the eval has one boolean to log/gate on instead of having
    // to know to reach into `screenshots[].hoverOk` (PR #272 review, P1-6:
    // this was computed and then dropped before it ever reached the eval).
    verdict.hoverOk =
      verdict.screenshots.length === WAYPOINTS.length &&
      verdict.screenshots.every((entry) => entry.hoverOk === true);

    return verdict;
  } catch (error) {
    // Nothing thrown here should ever surface as a hook exception: that is
    // exactly the "infra failure, not an agent result" escape hatch PR #272's
    // review (P1-5) demonstrates an agent can trigger deliberately (e.g. by
    // making `.agent-evals` a file). Record it on the verdict — which still
    // has every gate at its default `false` unless a real stage set it `true`
    // — and let `writeVerdict` (below) export it as an honest, explained loss.
    const detail = error instanceof Error && error.stack ? error.stack : String(error);
    verdict.notes.push(
      `verifyN1HeroShader threw and was caught here so the turn can still complete: ${detail}`.slice(
        0,
        1000,
      ),
    );
    return verdict;
  } finally {
    await writeVerdict(sandbox, verdict);
  }
}

/** @param {{data: Buffer, width: number, height: number}} png */
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

/**
 * Written into the workspace so it travels out in the same tar as the
 * screenshots — one artifact set, one export, no second channel to keep in
 * sync. Failure-tolerant on purpose: an agent that replaces `.agent-evals`
 * with a plain file makes the first write throw ENOTDIR. Clear that specific
 * obstruction and retry once; if it still cannot be written, swallow the
 * error rather than let it escape — a missing `n1-verify.json` is a state the
 * eval already has to handle (freshness gate), whereas an uncaught exception
 * here turns a real loss into a reported infra failure (PR #272 review, P1-5).
 * @param {any} sandbox
 * @param {N1Verdict} verdict
 */
async function writeVerdict(sandbox, verdict) {
  const path = `${ARTIFACT_DIR}/n1-verify.json`;
  try {
    await sandbox.writeTextFile({ path, content: JSON.stringify(verdict, null, 2) });
  } catch (error) {
    verdict.notes.push(
      `writeVerdict: first attempt failed (${String(error).slice(0, 200)}), clearing ` +
        `${ARTIFACT_DIR} and retrying once`,
    );
    try {
      await sh(sandbox, `rm -rf ${shellQuote(ARTIFACT_DIR)} && mkdir -p ${shellQuote(ARTIFACT_DIR)}`);
      await sandbox.writeTextFile({ path, content: JSON.stringify(verdict, null, 2) });
    } catch (retryError) {
      // Truly could not persist the verdict anywhere under the workspace. Do
      // not throw — see the doc comment above — the eval will simply see no
      // n1-verify.json and grade that state, and the turn still completes and
      // exports whatever tar it can.
      // eslint-disable-next-line no-console
      console.error(
        `[n1-hero-shader verify] could not write ${path} after retry: ${String(retryError)}`,
      );
    }
  }
}
