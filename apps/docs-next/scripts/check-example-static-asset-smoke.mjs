#!/usr/bin/env node
/**
 * TGEIST-EXAMPLES-STATIC — smoke gate for same-origin example static assets against the i18n proxy.
 *
 * Sibling of `check-ml-asset-smoke.mjs` (TGEIST-ML-ASSETS), same failure mode, different asset
 * class: `next build` passes even when a static file under `public/examples/**` 404s under the
 * geistdocs i18n proxy, because from the build's point of view nothing it rendered is missing --
 * the asset is not a page, it is a file the browser (gallery cards, sidebar thumbnails, or the
 * example itself) fetches at runtime by absolute path. `thumbs:check` (gate G6) doesn't catch it
 * either: it renders the example thumbnails in Node, with no proxy (and no i18n) anywhere in the
 * loop. That gap is exactly how this shipped silently: every `<slug>.card.png` / `<slug>.hero.png`
 * thumbnail and `depth-estimation/source.jpg` (the demo's default input image) 404'd under the
 * proxy while `/examples/[slug]` itself (a real, localized page) rendered fine.
 *
 * This is the 4th sibling of this exact class in this proxy (TGEIST-06 `.well-known`, TGEIST-08
 * `/preview/**`, TGEIST-ML-ASSETS `models/`/`ort/`, this one `examples/**.{png,jpg,...}`) -- see
 * the ANCHOR TGEIST-EXAMPLES-STATIC comment in `proxy.ts` for the fix itself.
 *
 * Starts `next start` on the production build (same pattern as `check-ml-asset-smoke.mjs`) and
 * GETs every file actually committed under `public/examples/**`, asserting:
 *
 *   1. status 200 -- not proxied into a localized 404.
 *   2. no `x-middleware-rewrite` response header. That header is the i18n proxy announcing it
 *      rewrote the request to `/en/...` before it ever reached the static file -- the literal
 *      signature of the bug this gate exists to catch (verified manually: 404 with this header set
 *      before the `proxy.ts` fix, 200 without it after).
 *   3. response bytes sha256-identical to the file already on disk, so a route silently shadowing
 *      the static file (rather than the proxy) would also fail here.
 *
 * The asset list is derived from what is actually on disk (recursive walk of `public/examples/`)
 * rather than hand-duplicated, so it can never drift from what's really committed -- new examples,
 * new thumbnails, or a new per-example asset directory (like `depth-estimation/`) are picked up
 * automatically. It also re-checks that `/examples/<slug>` page routes are still proxied (still
 * carry `x-middleware-rewrite`), so a future over-broad fix to the exclusion pattern that
 * accidentally swallows the page routes themselves fails loudly here instead of shipping.
 *
 * Needs a production build with `ingest-examples.mjs` already run -- same precondition as
 * `check-ml-asset-smoke.mjs`. `pnpm --filter docs-next build` runs it via `prebuild`, so in CI this
 * only ever needs to run right after `build`, in the same job.
 *
 * Usage:
 *   node scripts/check-example-static-asset-smoke.mjs                  # starts `next start` itself
 *   node scripts/check-example-static-asset-smoke.mjs --base-url=http://localhost:3000
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(SCRIPT_DIR, "..");
const PUBLIC_DIR = join(APP_ROOT, "public");
const EXAMPLES_DIR = join(PUBLIC_DIR, "examples");
const READY_TIMEOUT_MS = 120_000;

// A couple of `/examples/[slug]` page routes to re-assert as *still proxied* (still localized),
// so an over-broad exclusion pattern that starts swallowing pages instead of just assets fails
// here instead of shipping. Picked from `public/examples/*.card.png` at runtime (see below) so
// this never references a slug that doesn't exist on this tree.

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

/** Every file committed under `public/examples/**`, recursively, sorted for stable output. */
function walkExamplesDir(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkExamplesDir(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function exampleStaticAssets() {
  if (!existsSync(EXAMPLES_DIR)) {
    throw new Error(`${relative(APP_ROOT, EXAMPLES_DIR)} is missing -- expected committed example assets.`);
  }
  return walkExamplesDir(EXAMPLES_DIR).map((diskPath) => ({
    // `relative()` returns OS-native separators; normalize to `/` for URL paths (this gate only
    // ever runs on POSIX CI/dev machines, but keep it honest).
    urlPath: `/${relative(PUBLIC_DIR, diskPath).split(sep).join("/")}`,
    diskPath,
    group: "examples",
  }));
}

/** Slugs with a committed `*.card.png`, used to sanity-check the page route is still proxied. */
function pageRoutesToReassert() {
  if (!existsSync(EXAMPLES_DIR)) return [];
  return readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith(".card.png"))
    .map((name) => name.slice(0, -".card.png".length))
    .sort();
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
  if (!existsSync(bin)) throw new Error(`cannot find the next binary at ${bin} -- run pnpm install`);
  if (!existsSync(join(APP_ROOT, ".next"))) {
    throw new Error(
      `no production build at ${join(APP_ROOT, ".next")} -- this gate smokes a real server, run \`pnpm --filter docs-next build\` first`,
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

async function checkPageStillProxied(baseUrl, slug) {
  const response = await fetch(`${baseUrl}/examples/${slug}`, { redirect: "manual" });
  const rewrite = response.headers.get("x-middleware-rewrite");
  const problems = [];
  if (response.status !== 200) problems.push(`status ${response.status} (expected 200)`);
  if (!rewrite || !rewrite.startsWith(`/en/examples/${slug}`)) {
    problems.push(
      `x-middleware-rewrite: ${rewrite ?? "(none)"} (expected /en/examples/${slug} -- the exclusion pattern for ` +
        "static example assets must not swallow the [slug] page route itself)",
    );
  }
  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const assets = exampleStaticAssets();
  const pageSlugs = pageRoutesToReassert();

  let server;
  const baseUrl = options.baseUrl ?? (server = await startServer()).baseUrl;

  const failures = [];
  try {
    for (const asset of assets) {
      const problems = await checkAsset(baseUrl, asset);
      if (problems.length === 0) {
        console.log(`  ok      ${asset.urlPath}`);
      } else {
        failures.push({ path: asset.urlPath, problems });
        console.error(`  FAIL    ${asset.urlPath}`);
        for (const problem of problems) console.error(`            ${problem}`);
      }
    }
    for (const slug of pageSlugs.slice(0, 3)) {
      const problems = await checkPageStillProxied(baseUrl, slug);
      if (problems.length === 0) {
        console.log(`  ok      /examples/${slug} (page, still proxied)`);
      } else {
        failures.push({ path: `/examples/${slug}`, problems });
        console.error(`  FAIL    /examples/${slug}`);
        for (const problem of problems) console.error(`            ${problem}`);
      }
    }
  } finally {
    server?.stop();
  }

  const total = assets.length + Math.min(pageSlugs.length, 3);
  if (failures.length > 0) {
    console.error(
      `\n${failures.length}/${total} example static asset check(s) failed the non-localized smoke check.\n` +
        "If this is `x-middleware-rewrite` on an asset, the i18n proxy matcher in proxy.ts regressed the " +
        "`examples/**.{png,jpg,...}` exclusion (TGEIST-EXAMPLES-STATIC). If it's a missing rewrite on a " +
        "page route, the exclusion pattern became too broad and started swallowing pages.",
    );
    process.exitCode = 1;
  } else {
    console.log(`\nExample static asset smoke check passed: ${total} check(s), all correct.`);
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
