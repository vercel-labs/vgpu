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

/** One capture per waypoint along the pointer path. Indices, not DOM ids. */
export const WAYPOINTS = [0, 1, 2, 3, 4];

/**
 * Relative path of the pointer-free baseline capture, taken before the pointer
 * is moved at all. It is NOT part of `screenshots[]` (the "a capture at every
 * waypoint" gate counts exactly `WAYPOINTS.length` entries); it is the honest
 * BEFORE image for the multimodal judge, which used to be handed `wp-0.png` —
 * a frame the pointer had already painted.
 */
export const N1_BASELINE_SCREENSHOT = `${N1_SCREENSHOT_DIR}/baseline.png`;

/**
 * Waypoints as FRACTIONS of the canvas box, resolved to pixels at runtime from
 * the canvas's own `getBoundingClientRect()`. Same five positions the seed's
 * invisible `.wp` anchors used to sit at, so the captures stay comparable with
 * the archived runs — but nothing in the page has to exist for them to work.
 *
 * Why fractions and a runtime box instead of `agent-browser hover <selector>`:
 * the anchors were styled `pointer-events: none`, and Playwright's (hence
 * agent-browser's) actionability check REFUSES to hover an element that cannot
 * receive pointer events. Every hover failed, no pointer event ever reached the
 * canvas, and the app's `pointerUv` uniform stayed at its default [0.5, 0.5] —
 * yet the captures still differed (the background is time-animated), so the
 * pass looked healthy while proving nothing about the pointer. Measured on the
 * archived green run: the chroma centroid sat at (629, 302) in all five
 * captures. `mouse move <x> <y>` dispatches at the coordinate regardless of
 * what is or is not in the DOM there, which is also how the evaluated agent
 * drove its own browser session.
 */
const PATH_FRACTIONS = [
  [0.1, 0.2],
  [0.3, 0.5],
  [0.5, 0.35],
  [0.7, 0.6],
  [0.9, 0.8],
];

/**
 * Intermediate pointer positions per waypoint leg. A trail is a HISTORY, so a
 * single jump to a coordinate cannot produce one: the pointer has to travel.
 * Six steps per leg at ~50 ms per `agent-browser mouse move` round trip puts
 * the whole leg inside ~300 ms, well inside the fade window of a trail that is
 * supposed to be visible to a human, and the capture follows immediately.
 */
const PATH_STEPS = 6;

/** Radii for the near/far pixel-delta measurement, as a fraction of the canvas's short side. */
const NEAR_RADIUS_FRACTION = 0.09;
const FAR_RADIUS_FRACTION = 0.225;

const DISPLAY = ":99";
const SESSION = "n1-verify";

/** Chromium is resolved via a shell glob under an agent-writable directory. */
const CHROMIUM_PATTERN = /^\/root\/\.cache\/ms-playwright\/chromium-[0-9]+\/chrome-linux\/chrome$/;

/**
 * @typedef {Object} N1Spatial
 * @property {number|null} near - mean |Δluma| (0-255) against the previous
 *   capture, inside a disc around this waypoint's pointer position.
 * @property {number|null} far - the same, over pixels far from EVERY waypoint:
 *   the time-animated background's own noise floor for this run.
 * @property {number|null} ratio - `near / far`. Pointer causality, measured.
 * @property {number} [maxDelta] - largest single-pixel |Δluma| in the frame.
 * @property {number[]} [maxDeltaAt] - where that pixel is, in image px.
 * @property {number} [maxDeltaOffset] - its distance from the pointer, image px.
 * @property {number} [nearRadius]
 * @property {number} [farRadius]
 * @property {string} [error]
 */

/**
 * @typedef {Object} N1ScreenshotEntry
 * @property {number} waypoint
 * @property {string} path
 * @property {boolean} pointerMoveOk - every `agent-browser mouse move` on the
 *   leg that ends at this waypoint reported success (exit code 0 AND
 *   `success: true` with `moved: true` in agent-browser's own `--json`
 *   envelope). Replaces the old `hoverOk`, which asked whether a hover of an
 *   invisible `pointer-events: none` anchor succeeded — it never could.
 * @property {number} [moveSteps] - pointer positions dispatched on this leg.
 * @property {number} [moveStepsOk] - how many of them reported success.
 * @property {number[]} [pointer] - the final commanded position, CSS px.
 * @property {boolean} decoded
 * @property {string} [sha256]
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [lumaStdDev]
 * @property {N1Spatial} [spatial]
 * @property {string} [error]
 */

/**
 * @typedef {Object} N1Verdict
 * @property {boolean} buildOk
 * @property {{stderrTail: string}} buildLog
 * @property {boolean} serverUp
 * @property {boolean} browserReady
 * @property {N1ScreenshotEntry[]} screenshots
 * @property {N1ScreenshotEntry|null} baseline - the pointer-free capture.
 * @property {boolean} screenshotsOk
 * @property {boolean} pointerMoveOk - aggregate: true only if every pointer
 *   move on every leg was reported ok. Same shape and same role as the old
 *   `hoverOk` aggregate (PR #272 review, P1-6) — one boolean the eval can log
 *   and gate on without reaching into `screenshots[].pointerMoveOk` — but it
 *   now answers a question that can actually be true.
 * @property {{x: number, y: number, w: number, h: number, vw: number, vh: number,
 *   dpr: number, canvases: number, source: string}|null} canvasBox - the box
 *   the pointer path was derived from, at runtime. Recorded so a reader can
 *   check the coordinates were real and inside the canvas.
 * @property {number|null} pixelScale - image px per CSS px in the captures.
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
    baseline: null,
    screenshotsOk: false,
    pointerMoveOk: false,
    canvasBox: null,
    pixelScale: null,
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
    // The exit code alone does not rule out the documented footgun: a session
    // that lost its browser falls back to about:blank and still prints "✓ Done".
    // Ask the page where it actually is before believing any of the captures.
    const landedOn = opened.exitCode === 0 ? await sh(sandbox, browser("get url"), env) : null;
    const onOurPage = Boolean(landedOn?.stdout.includes(`http://localhost:${port}/`));
    verdict.browserReady = opened.exitCode === 0 && onOurPage;
    if (!verdict.browserReady) {
      verdict.notes.push(
        opened.exitCode !== 0
          ? `agent-browser could not open the page: ${opened.stderr.slice(-500)}`
          : `agent-browser reported success but the session is not on the served page ` +
              `(get url said: ${(landedOn?.stdout ?? "").trim().slice(0, 200)}) — treated as a ` +
              `failed browser, not a pass`,
      );
      return verdict;
    }
    // Let the first frames render before the baseline capture, so "before" is a
    // live canvas rather than an empty one.
    await sh(sandbox, browser("wait 2000"), env);

    // ---- 5. Resolve the pointer path from the canvas's own box -------------
    // Coordinates are MEASURED at runtime, never hardcoded: the canvas is
    // whatever the agent built, at whatever size the viewport gave it. The
    // largest canvas in the document wins; if there is no canvas at all, the
    // viewport is used, so a page without one still gets a real pointer pass
    // (and fails the gates that actually care, rather than this one).
    const boxExpr =
      "(() => { const cs = Array.from(document.querySelectorAll('canvas')); " +
      "let best = null, bestArea = -1; " +
      "for (const c of cs) { const r = c.getBoundingClientRect(); const a = r.width * r.height; " +
      "if (a > bestArea) { bestArea = a; best = r; } } " +
      "const r = best && bestArea > 0 ? best : { x: 0, y: 0, width: innerWidth, height: innerHeight }; " +
      "return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, " +
      "vh: innerHeight, dpr: devicePixelRatio, canvases: cs.length, " +
      "source: best && bestArea > 0 ? 'canvas' : 'viewport' }); })()";
    const boxResult = await sh(sandbox, browser(`eval ${shellQuote(boxExpr)} --json`), env);
    const box = parseCanvasBox(boxResult.stdout);
    if (!box) {
      verdict.notes.push(
        `could not measure a canvas box to aim the pointer at (agent-browser eval said: ` +
          `${boxResult.stdout.trim().slice(-300)}) — no pointer pass was attempted`,
      );
      return verdict;
    }
    verdict.canvasBox = box;
    if (box.source === "viewport") {
      verdict.notes.push(
        "no canvas found in the page; the pointer path was aimed at the viewport instead",
      );
    }

    const legs = buildPointerPath(box);

    // ---- 6. Baseline capture, before the pointer has moved at all ----------
    // The judge's BEFORE image used to be wp-0.png, which the pointer had
    // already painted. This one is genuinely pointer-free, which also makes it
    // the reference frame for the near/far measurement below.
    const baselinePath = `${SCREENSHOT_DIR}/baseline.png`;
    await sh(sandbox, browser(`screenshot ${shellQuote(baselinePath)}`), env);
    const baselineEntry = await readCapture(sandbox, baselinePath, {
      waypoint: -1,
      path: N1_BASELINE_SCREENSHOT,
      pointerMoveOk: true,
    });
    verdict.baseline = baselineEntry.entry;

    // ---- 7. Drive the pointer along the path, capturing at each waypoint ---
    /** @type {(import("pngjs").PNG|null)[]} */
    const decodedPngs = [];
    let previousPng = baselineEntry.png;
    for (const leg of legs) {
      let stepsOk = 0;
      for (const [x, y] of leg.steps) {
        // agent-browser's own JSON envelope, not a "✓" in prose: `moved: true`
        // is the machine-readable statement that the pointer went where it was
        // told. The exit code is still required — this is an AND, not a
        // replacement — because a crashed CLI can print nothing at all.
        const move = await sh(sandbox, browser(`mouse move ${x} ${y} --json`), env);
        if (move.exitCode === 0 && pointerMoved(move.stdout)) stepsOk += 1;
      }
      // A beat between the last move and the capture: a trail that fades over
      // time needs the frame just after the pointer arrived. Short on purpose —
      // the trail in the reference implementation decays to ~1% in about a
      // second, so a long wait would photograph an empty canvas.
      await sh(sandbox, browser("wait 250"), env);
      const path = `${SCREENSHOT_DIR}/wp-${leg.waypoint}.png`;
      await sh(sandbox, browser(`screenshot ${shellQuote(path)}`), env);

      const { entry, png } = await readCapture(sandbox, path, {
        waypoint: leg.waypoint,
        path: `${N1_SCREENSHOT_DIR}/wp-${leg.waypoint}.png`,
        pointerMoveOk: stepsOk === leg.steps.length,
      });
      entry.moveSteps = leg.steps.length;
      entry.moveStepsOk = stepsOk;
      entry.pointer = leg.target;
      verdict.screenshots.push(entry);
      decodedPngs.push(png);
      if (png) {
        entry.spatial = measureSpatial({
          previous: previousPng,
          current: png,
          box,
          pointer: leg.target,
          allPointers: legs.map((other) => other.target),
        });
        previousPng = png;
      }
    }

    await sh(sandbox, browser("close"), env);

    const firstDecoded = decodedPngs.find(Boolean) ?? baselineEntry.png;
    verdict.pixelScale = firstDecoded ? Number((firstDecoded.width / box.vw).toFixed(3)) : null;

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
    // to know to reach into `screenshots[].pointerMoveOk` (PR #272 review,
    // P1-6: this was computed and then dropped before it ever reached the
    // eval). Loud on purpose: a run where the pointer never moved reports
    // `pointerMoveOk: false`, carries a note naming the legs that failed, and
    // its per-capture `spatial.ratio` sits at the background noise floor (~1)
    // instead of the 25-40 a real pointer produces.
    verdict.pointerMoveOk =
      verdict.screenshots.length === WAYPOINTS.length &&
      verdict.screenshots.every((entry) => entry.pointerMoveOk === true);
    if (!verdict.pointerMoveOk) {
      const failed = verdict.screenshots
        .filter((entry) => entry.pointerMoveOk !== true)
        .map((entry) => `wp-${entry.waypoint} (${entry.moveStepsOk ?? 0}/${entry.moveSteps ?? 0} moves ok)`);
      verdict.notes.push(
        `agent-browser did not report a successful pointer move on every step of every leg: ` +
          `${failed.join(", ") || "no legs were driven at all"} — the captures below cannot be ` +
          `read as evidence about the pointer`,
      );
    }

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

/**
 * agent-browser's `--json` envelope for `mouse move` is
 * `{"success":true,"data":{...,"moved":true},"error":null}`. Both halves are
 * required: `success` is the CLI's own verdict, `moved` is the statement that a
 * pointer event was actually dispatched. Parsed, not regexed for a "✓", so a
 * run where the pointer never moved cannot look like one where it did.
 * @param {string} stdout
 */
function pointerMoved(stdout) {
  try {
    const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
    return parsed?.success === true && parsed?.data?.moved === true;
  } catch {
    return false;
  }
}

/**
 * `agent-browser eval <expr> --json` wraps the expression's return value as a
 * STRING in `data.result`, so the box comes back double-encoded.
 * @param {string} stdout
 */
function parseCanvasBox(stdout) {
  try {
    const envelope = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
    if (envelope?.success !== true) return null;
    const raw = envelope?.data?.result;
    const box = typeof raw === "string" ? JSON.parse(raw) : raw;
    const numbers = ["x", "y", "w", "h", "vw", "vh"];
    if (!box || numbers.some((key) => !Number.isFinite(box[key]))) return null;
    if (box.w < 8 || box.h < 8) return null;
    return box;
  } catch {
    return null;
  }
}

/**
 * The pointer path: one leg per waypoint, each leg a straight run of
 * `PATH_STEPS` positions from the previous waypoint to this one. The first leg
 * starts slightly up-and-left of waypoint 0 so even that capture has some
 * travel behind it — a trail needs a history, and a single dispatch at a
 * coordinate has none.
 * @param {{x: number, y: number, w: number, h: number}} box
 */
function buildPointerPath(box) {
  /** @param {number} value */
  const clampX = (value) =>
    Math.round(Math.min(box.x + box.w - 2, Math.max(box.x + 2, value)));
  /** @param {number} value */
  const clampY = (value) =>
    Math.round(Math.min(box.y + box.h - 2, Math.max(box.y + 2, value)));
  const targets = PATH_FRACTIONS.map(([fx, fy]) => [
    clampX(box.x + fx * box.w),
    clampY(box.y + fy * box.h),
  ]);
  return targets.map((target, index) => {
    const from =
      index === 0
        ? [clampX(target[0] - box.w * 0.08), clampY(target[1] - box.h * 0.08)]
        : targets[index - 1];
    const steps = [];
    for (let step = 1; step <= PATH_STEPS; step += 1) {
      const t = step / PATH_STEPS;
      steps.push([
        Math.round(from[0] + (target[0] - from[0]) * t),
        Math.round(from[1] + (target[1] - from[1]) * t),
      ]);
    }
    return { waypoint: WAYPOINTS[index], target, steps };
  });
}

/**
 * Reads a capture back out of the sandbox and fills in the fields every entry
 * shares. Returns the decoded PNG too, so the caller can measure it without
 * transferring the bytes twice.
 * @param {any} sandbox
 * @param {string} path
 * @param {{waypoint: number, path: string, pointerMoveOk: boolean}} base
 */
async function readCapture(sandbox, path, base) {
  /** @type {N1ScreenshotEntry} */
  const entry = { ...base, decoded: false };
  const bytes = await sandbox.readBinaryFile({ path }).catch(() => null);
  if (!bytes) return { entry, png: null };
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
    return { entry, png };
  } catch (error) {
    entry.decoded = false;
    entry.error = String(error).slice(0, 200);
    return { entry, png: null };
  }
}

/**
 * Measures, per capture, how much brighter/darker the pixels NEAR the pointer
 * got compared with pixels FAR from every waypoint. Recorded, deliberately not
 * gated yet (see the README roadmap): a threshold gets to be a gate once a live
 * run has produced these numbers on the real task, not before.
 *
 * PROPOSED THRESHOLD. Three populations measured so far, all in a container
 * against the archived green run's own shipped app, all with this same code:
 *
 *   positive A — pointer hand-driven along this path (Phase 1, by hand):
 *     near 67.45-102.53, far 2.54-2.66, ratio 25.49-40.32 at all five
 *     waypoints; largest changed pixel 5-23 px from the commanded coordinate.
 *   positive B — this module's own rehearsal against the same app:
 *     near 51.07-85.06, far 3.01-5.86, ratio 14.52-18.22 at all five
 *     waypoints; largest changed pixel 7-14 px away.
 *   negative — the SAME app with its pointer listeners removed, so it renders
 *     and animates but cannot react (which is the state the archived green run
 *     was actually in: every hover refused by the `pointer-events: none`
 *     anchors): near 2.87-4.17, far 3.31-3.46, ratio 0.85-1.26; largest changed
 *     pixel 121-783 px away. The archived run's own captures measure the same:
 *     near 2.59-4.26, far 2.90-3.54, ratio 0.89-1.20.
 *
 *   => `ratio >= 4` at every waypoint. That is 3.6x below the weakest positive
 *      (14.52) and 3.2x above the strongest negative (1.26) — on a log scale
 *      almost exactly between them — and being a RATIO it cannot be gamed by
 *      making the whole background flicker harder, since that lifts `far` too.
 *   => optional companion, if a stricter spatial claim is wanted:
 *      `maxDeltaOffset <= 0.1 * min(canvas.w, canvas.h)` (69 px at the observed
 *      1050x693) — 4.9x above the worst positive (14 px) and 1.75x below the
 *      best negative (121 px).
 *   => `far` on its own is NOT a threshold candidate: it is the background's
 *      own noise floor and it is nearly identical (2.5-5.9) whether or not the
 *      pointer works. Only the near/far RELATION separates them.
 *
 * @param {{previous: any, current: any, box: {w: number, h: number, vw: number},
 *   pointer: number[], allPointers: number[][]}} input
 * @returns {N1Spatial}
 */
function measureSpatial({ previous, current, box, pointer, allPointers }) {
  if (!previous || !current) {
    return { near: null, far: null, ratio: null, error: "no reference capture to compare against" };
  }
  if (previous.width !== current.width || previous.height !== current.height) {
    return { near: null, far: null, ratio: null, error: "capture size changed between frames" };
  }
  // Captures are in image pixels; the pointer was commanded in CSS pixels.
  const scale = current.width / Math.max(1, box.vw);
  const shortSide = Math.min(box.w, box.h) * scale;
  const nearRadius = Math.max(8, Math.round(shortSide * NEAR_RADIUS_FRACTION));
  const farRadius = Math.max(nearRadius + 1, Math.round(shortSide * FAR_RADIUS_FRACTION));
  const at = [pointer[0] * scale, pointer[1] * scale];
  const others = allPointers.map((point) => [point[0] * scale, point[1] * scale]);

  const before = lumaPlane(previous);
  const after = lumaPlane(current);
  let nearSum = 0;
  let nearCount = 0;
  let farSum = 0;
  let farCount = 0;
  let maxDelta = 0;
  let maxDeltaAt = [0, 0];
  for (let y = 0; y < current.height; y += 1) {
    for (let x = 0; x < current.width; x += 1) {
      const index = y * current.width + x;
      const delta = Math.abs(after[index] - before[index]);
      if (delta > maxDelta) {
        maxDelta = delta;
        maxDeltaAt = [x, y];
      }
      const dx = x - at[0];
      const dy = y - at[1];
      if (dx * dx + dy * dy <= nearRadius * nearRadius) {
        nearSum += delta;
        nearCount += 1;
      }
      let far = true;
      for (const other of others) {
        const ox = x - other[0];
        const oy = y - other[1];
        if (ox * ox + oy * oy <= farRadius * farRadius) {
          far = false;
          break;
        }
      }
      if (far) {
        farSum += delta;
        farCount += 1;
      }
    }
  }
  const near = nearCount > 0 ? nearSum / nearCount : null;
  const far = farCount > 0 ? farSum / farCount : null;
  return {
    near: near === null ? null : Number(near.toFixed(2)),
    far: far === null ? null : Number(far.toFixed(2)),
    ratio: near !== null && far !== null && far > 0 ? Number((near / far).toFixed(2)) : null,
    maxDelta: Number(maxDelta.toFixed(2)),
    maxDeltaAt,
    maxDeltaOffset: Math.round(Math.hypot(maxDeltaAt[0] - at[0], maxDeltaAt[1] - at[1])),
    nearRadius,
    farRadius,
  };
}

/** @param {{data: Buffer, width: number, height: number}} png */
function lumaPlane(png) {
  const plane = new Float32Array(png.width * png.height);
  for (let index = 0, pixel = 0; index < png.data.length; index += 4, pixel += 1) {
    plane[pixel] =
      0.2126 * png.data[index] + 0.7152 * png.data[index + 1] + 0.0722 * png.data[index + 2];
  }
  return plane;
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
