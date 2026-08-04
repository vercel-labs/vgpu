#!/usr/bin/env node
/**
 * TGEIST-ML-ASSETS — smoke gate for same-origin ML assets against the i18n proxy.
 *
 * `next build` passes even when a same-origin ML asset 404s under the geistdocs proxy, because
 * from the build's point of view nothing it rendered is missing — the asset was never a page, it's
 * a file the browser fetches at runtime. `thumbs:check` (gate G6) doesn't catch it either: it
 * renders the example thumbnails in Node, with no proxy (and no i18n) anywhere in the loop. That gap
 * is exactly how the `models/`/`ort/` proxy matcher hole (fixed alongside this script in
 * `proxy.ts`) shipped silently: mnist-classifier and depth-estimation threw `OrtEnvironmentError`
 * fetching their own models, and air-painting would fail the same way the moment it starts
 * fetching its two hand models.
 *
 * This starts `next start` on the production build (same pattern as
 * `check-url-anchor-parity.mjs`) and GETs every critical, non-localized ML asset path, asserting:
 *
 *   1. status 200 — not proxied into a localized 404.
 *   2. no `x-middleware-rewrite` response header. That header is the i18n proxy announcing it
 *      rewrote the request to `/en/...` before it ever reached the static file — the literal
 *      signature of the bug this gate exists to catch (verified manually: 404 with this header set
 *      before the `proxy.ts` fix, 200 without it after).
 *   3. response bytes sha256-identical to the file already on disk, so a route silently shadowing
 *      the static file (rather than the proxy) would also fail here.
 *
 * The asset list is derived from what is actually on disk rather than hand-duplicated, so it can
 * never drift from the files the examples really fetch:
 *   - every `*.onnx` committed under `public/models/mnist/**` and `public/models/mediapipe-hands/**`
 *   - `/ort/manifest.json` (written by `prepare-ort-assets.mjs`)
 *   - every model file listed in `public/models/depth/manifest.json` (written by
 *     `prepare-depth-models.mjs`)
 *
 * Needs a production build with both prepare scripts already run — same precondition as
 * `check-url-anchor-parity.mjs`, checked the same way. `pnpm --filter docs-next build` runs both
 * via `prebuild`, so in CI this only ever needs to run right after `build`, in the same job.
 *
 * Usage:
 *   node scripts/check-ml-asset-smoke.mjs                  # starts `next start` itself
 *   node scripts/check-ml-asset-smoke.mjs --base-url=http://localhost:3000
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, "..");
const PUBLIC_DIR = join(APP_ROOT, "public");
const READY_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const options = { baseUrl: null };
  for (const arg of argv) {
    const eq = arg.indexOf("=");
    const [key, value] = eq === -1 ? [arg, ""] : [arg.slice(0, eq), arg.slice(eq + 1)];
    if (key === "--base-url") options.baseUrl = value.replace(/\/$/u, "");
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every committed `*.onnx` directly inside `public/<dirRelative>/`, sorted for stable output. */
function trackedOnnxFiles(dirRelative) {
  const dir = join(PUBLIC_DIR, dirRelative);
  if (!existsSync(dir)) {
    throw new Error(`${relative(APP_ROOT, dir)} is missing — expected committed ONNX assets.`);
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".onnx"))
    .sort()
    .map((name) => ({
      urlPath: `/${dirRelative}/${name}`,
      diskPath: join(dir, name),
      group: dirRelative,
    }));
}

/** `/ort/manifest.json`, staged by `prepare-ort-assets.mjs`. */
function ortManifestAsset() {
  const manifestPath = join(PUBLIC_DIR, "ort", "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${relative(APP_ROOT, manifestPath)} is missing — run \`pnpm --filter docs-next ort:assets\` ` +
        "(this is a build precondition; `prebuild` runs it automatically).",
    );
  }
  return { urlPath: "/ort/manifest.json", diskPath: manifestPath, group: "ort" };
}

/** Every depth model file listed in the manifest `prepare-depth-models.mjs` staged. */
function depthModelAssets() {
  const depthDir = join(PUBLIC_DIR, "models", "depth");
  const manifestPath = join(depthDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${relative(APP_ROOT, manifestPath)} is missing — run \`pnpm --filter docs-next depth:models\` ` +
        "(this is a build precondition; `prebuild` runs it automatically).",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return manifest.models.map(({ file }) => ({
    urlPath: `/models/depth/${file}`,
    diskPath: join(depthDir, file),
    group: "models/depth",
  }));
}

function criticalAssets() {
  return [
    ...trackedOnnxFiles("models/mnist"),
    ...trackedOnnxFiles("models/mediapipe-hands"),
    ortManifestAsset(),
    ...depthModelAssets(),
  ];
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`\`next start\` exited with code ${child.exitCode} before becoming ready`);
    }
    try {
      const response = await fetch(`${baseUrl}/docs`, { redirect: "manual" });
      if (response.status > 0) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${baseUrl} did not become ready within ${READY_TIMEOUT_MS}ms`);
}

async function startServer() {
  const bin = join(APP_ROOT, "node_modules/.bin/next");
  if (!existsSync(bin)) throw new Error(`cannot find the next binary at ${bin} — run pnpm install`);
  if (!existsSync(join(APP_ROOT, ".next"))) {
    throw new Error(
      `no production build at ${join(APP_ROOT, ".next")} — this gate smokes a real server, run \`pnpm --filter docs-next build\` first`,
    );
  }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(bin, ["start", "--port", String(port)], {
    cwd: APP_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (chunk) => log.push(String(chunk)));
  child.stderr.on("data", (chunk) => log.push(String(chunk)));
  try {
    await waitForServer(baseUrl, child);
  } catch (error) {
    child.kill("SIGKILL");
    console.error(log.join(""));
    throw error;
  }
  return { baseUrl, stop: () => child.kill("SIGTERM") };
}

async function checkAsset(baseUrl, asset) {
  const response = await fetch(`${baseUrl}${asset.urlPath}`, { redirect: "manual" });
  const rewrite = response.headers.get("x-middleware-rewrite");
  const body = new Uint8Array(await response.arrayBuffer());
  const expected = readFileSync(asset.diskPath);

  const problems = [];
  if (response.status !== 200) problems.push(`status ${response.status} (expected 200)`);
  if (rewrite) problems.push(`x-middleware-rewrite: ${rewrite} (i18n proxy rewrote this asset)`);
  if (body.length !== expected.length || sha256(body) !== sha256(expected)) {
    problems.push(
      `body mismatch (got ${body.length} bytes / sha256 ${sha256(body)}, expected ${expected.length} bytes / sha256 ${sha256(expected)})`,
    );
  }
  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const assets = criticalAssets();

  let server;
  const baseUrl = options.baseUrl ?? (server = await startServer()).baseUrl;

  const failures = [];
  try {
    for (const asset of assets) {
      const problems = await checkAsset(baseUrl, asset);
      if (problems.length === 0) {
        console.log(`  ok      ${asset.urlPath}`);
      } else {
        failures.push({ asset, problems });
        console.error(`  FAIL    ${asset.urlPath}`);
        for (const problem of problems) console.error(`            ${problem}`);
      }
    }
  } finally {
    server?.stop();
  }

  if (failures.length > 0) {
    console.error(
      `\n${failures.length}/${assets.length} ML asset(s) failed the non-localized smoke check.\n` +
        "If this is `x-middleware-rewrite`, the i18n proxy matcher in proxy.ts regressed the " +
        "`models/`/`ort/` exclusion (TGEIST-ML-ASSETS).",
    );
    process.exitCode = 1;
  } else {
    console.log(`\nML asset smoke check passed: ${assets.length} asset(s), all 200 and unproxied.`);
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
