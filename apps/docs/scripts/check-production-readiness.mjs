#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READY_TIMEOUT_MS = 120_000;
const CANONICAL_ORIGIN = "https://vgpu.sh";
const DEPLOYMENT_ALIAS = "vgpu.labs.vercel.dev";

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`next start exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/`, { redirect: "manual" });
      if (response.status > 0) return;
    } catch {
      // Server is not listening yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  fail(`next start did not become ready within ${READY_TIMEOUT_MS}ms`);
}

async function startServer() {
  const bin = join(APP_ROOT, "node_modules/.bin/next");
  assert(existsSync(bin), `Next binary is missing at ${bin}; run pnpm install`);
  assert(existsSync(join(APP_ROOT, ".next")), "Production build is missing; run pnpm --filter docs build first");

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(bin, ["start", "--port", String(port)], {
    cwd: APP_ROOT,
    // Point the production server at the generated tree in this checkout. The separate tracing
    // gate proves the same tree is bundled into deployment output; this smoke is responsible for
    // exercising the HTTP contract rather than guessing Next's platform-specific trace layout.
    env: {
      ...process.env,
      PORT: String(port),
      VGPU_EXAMPLES_LOCAL_ROOT: join(APP_ROOT, "generated/examples-api"),
    },
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

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function assertMarkdownResponse(response, label, expectedStatus = 200) {
  assert(response.status === expectedStatus, `${label}: status ${response.status}, expected ${expectedStatus}`);
  assert(response.headers.get("content-type")?.includes("text/markdown"), `${label}: expected text/markdown`);
  assert(response.headers.get("vary")?.toLowerCase().split(/\s*,\s*/u).includes("accept"), `${label}: expected Vary: Accept`);
}

async function request(baseUrl, path, init) {
  return fetch(`${baseUrl}${path}`, { redirect: "manual", ...init });
}

async function checkHomepage(baseUrl) {
  const response = await request(baseUrl, "/", { headers: { Accept: "text/html" } });
  const html = await response.text();
  assert(response.status === 200, `homepage: status ${response.status}`);
  assert(/<h1\b/iu.test(html), "homepage: raw SSR HTML has no h1");
  assert(visibleText(html).length >= 500, `homepage: only ${visibleText(html).length} visible SSR characters`);
  assert(html.includes('<link rel="canonical" href="https://vgpu.sh"'), "homepage: canonical metadata is missing");
  for (const property of ["og:type", "og:title", "og:description", "og:url", "og:image"]) {
    assert(html.includes(`property="${property}"`), `homepage: ${property} is missing`);
  }
  assert(html.includes("https://vgpu.sh/opengraph-image"), "homepage: canonical OG image URL is missing");

  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/iu);
  assert(jsonLdMatch, "homepage: JSON-LD is missing from server HTML");
  const jsonLd = JSON.parse(jsonLdMatch[1]);
  const types = jsonLd["@graph"].map((entry) => entry["@type"]);
  assert(types.includes("WebSite") && types.includes("SoftwareSourceCode"), "homepage: JSON-LD entities are incomplete");
  assert(!html.includes(DEPLOYMENT_ALIAS), "homepage: deployment alias leaked into metadata");
  console.log("  ok  homepage SSR, canonical, Open Graph, and JSON-LD");
}

async function checkMarkdown(baseUrl) {
  const negotiated = await request(baseUrl, "/", { headers: { Accept: "text/markdown" } });
  const negotiatedBody = await negotiated.text();
  assertMarkdownResponse(negotiated, "negotiated homepage");
  assert(negotiated.headers.get("link") === '<https://vgpu.sh/>; rel="canonical"', "negotiated homepage: canonical Link is wrong");

  const index = await request(baseUrl, "/index.md");
  const indexBody = await index.text();
  assertMarkdownResponse(index, "/index.md");
  assert(indexBody === negotiatedBody, "/index.md and negotiated homepage Markdown differ");

  const docs = await request(baseUrl, "/docs/get-started", { headers: { Accept: "text/markdown" } });
  const docsBody = await docs.text();
  assertMarkdownResponse(docs, "valid docs Markdown");
  assert(docs.headers.get("link")?.includes(CANONICAL_ORIGIN), "valid docs Markdown: canonical Link is not apex-hosted");
  assert(docsBody.length > 200, "valid docs Markdown: body is unexpectedly short");

  const missing = await request(baseUrl, "/docs/definitely-missing-agent-readiness", { headers: { Accept: "text/markdown" } });
  const missingBody = await missing.text();
  assertMarkdownResponse(missing, "missing docs Markdown", 404);
  assert(/Page Not Found|suggest/iu.test(missingBody), "missing docs Markdown: useful recovery body is missing");
  assert(missingBody.includes("/llms.txt"), "missing docs Markdown: full index link is missing");
  console.log("  ok  homepage/docs Markdown negotiation and useful 404 recovery");
}

async function checkHtmlNotFound(baseUrl) {
  const response = await request(baseUrl, "/definitely-missing-agent-readiness", { headers: { Accept: "text/html" } });
  const html = await response.text();
  assert(response.status === 404, `HTML 404: status ${response.status}`);
  for (const expected of ["Page not found", "/docs", "/examples", "Search the docs", "/sitemap.md", "/llms.txt"]) {
    assert(html.includes(expected), `HTML 404: missing ${expected}`);
  }
  console.log("  ok  branded HTML 404 and recovery links");
}

async function checkApi(baseUrl) {
  const openApi = await request(baseUrl, "/openapi.json");
  const document = await openApi.json();
  assert(openApi.status === 200, `OpenAPI: status ${openApi.status}`);
  assert(openApi.headers.get("content-type")?.includes("application/json"), "OpenAPI: wrong content type");
  assert(document.openapi === "3.1.0", "OpenAPI: version is not 3.1.0");

  const discovery = await request(baseUrl, "/.well-known/vgpu-examples.json");
  const discoveryBody = await discovery.json();
  if (process.platform === "darwin" && discovery.status === 404) {
    // The hardened local artifact reader is fd-relative: Linux exposes traversable
    // `/proc/self/fd/<fd>/...`, while macOS `/dev/fd/<fd>/...` cannot be traversed. CI and Vercel
    // are Linux and remain strict; on a Mac, require the frozen JSON error contract and leave the
    // security-sensitive storage implementation outside this readiness change.
    assert(discoveryBody.error?.code === "VGPU-EXAMPLES-NOT-FOUND", "examples discovery: unexpected Darwin fallback");
    console.log("  skip examples discovery 200 on Darwin (fd-relative local store is Linux-only)");
  } else {
    assert(discovery.status === 200 && discoveryBody.protocol === "vgpu-examples", "examples discovery is unreachable");
  }

  const missingRevision = "0".repeat(64);
  const missing = await request(baseUrl, `/api/examples/v1/revisions/${missingRevision}/index.json`);
  const missingJson = await missing.json();
  assert(missing.status === 404, `examples JSON 404: status ${missing.status}`);
  assert(missing.headers.get("content-type")?.includes("application/json"), "examples JSON 404: wrong content type");
  assert(missingJson.error?.code === "VGPU-EXAMPLES-NOT-FOUND", "examples JSON 404: frozen code changed");

  const method = await request(baseUrl, "/api/examples/v1/latest.json", { method: "POST" });
  const methodJson = await method.json();
  assert(method.status === 405, `examples JSON 405: status ${method.status}`);
  assert(method.headers.get("allow") === "GET, HEAD, OPTIONS", "examples JSON 405: Allow header changed");
  assert(methodJson.error?.code === "VGPU-EXAMPLES-METHOD-NOT-ALLOWED", "examples JSON 405: frozen code changed");
  console.log("  ok  OpenAPI, discovery, and frozen examples JSON errors");
}

async function checkAgentResources(baseUrl) {
  const agents = await request(baseUrl, "/agents.md");
  const body = await agents.text();
  assert(agents.status === 200, `agents.md: status ${agents.status}`);
  for (const expected of ["openapi.json", "docs/cli", "npmjs.com/package/vgpu", ".well-known/vgpu-examples.json"]) {
    assert(body.toLowerCase().includes(expected.toLowerCase()), `agents.md: missing ${expected}`);
  }
  assert(!body.toLowerCase().includes("mcp server"), "agents.md: undeclared MCP support leaked in");

  const mcp = await request(baseUrl, "/.well-known/mcp.json");
  assert(mcp.status === 404, `MCP manifest must remain 404, received ${mcp.status}`);
  console.log("  ok  agent metadata advertises API/CLI/npm and leaves MCP undeclared");
}

async function checkCanonicalMachineFiles(baseUrl) {
  for (const path of ["/sitemap.xml", "/robots.txt", "/rss.xml"]) {
    const response = await request(baseUrl, path);
    const body = await response.text();
    assert(response.status === 200, `${path}: status ${response.status}`);
    assert(body.includes(CANONICAL_ORIGIN), `${path}: canonical origin is missing`);
    assert(!body.includes(DEPLOYMENT_ALIAS), `${path}: deployment alias leaked`);
  }
  console.log("  ok  sitemap, robots, and RSS use only the apex origin");
}

async function checkTrustPages(baseUrl) {
  for (const [path, phrases] of [
    ["/about", ["About vgpu", "MIT License", "npmjs.com/package/vgpu", "github.com/vercel-labs/vgpu"]],
    ["/contact", ["Contact and support", "GitHub issue tracker", "minimal reproduction", "GPU/driver"]],
  ]) {
    const response = await request(baseUrl, path);
    const html = await response.text();
    assert(response.status === 200, `${path}: status ${response.status}`);
    assert(html.includes(`<link rel="canonical" href="${CANONICAL_ORIGIN}${path}"`), `${path}: canonical metadata is missing`);
    for (const phrase of phrases) assert(html.includes(phrase), `${path}: missing substantive content ${phrase}`);
  }
  console.log("  ok  About and Contact trust pages");
}

async function main() {
  const server = await startServer();
  try {
    await checkHomepage(server.baseUrl);
    await checkMarkdown(server.baseUrl);
    await checkHtmlNotFound(server.baseUrl);
    await checkApi(server.baseUrl);
    await checkAgentResources(server.baseUrl);
    await checkCanonicalMachineFiles(server.baseUrl);
    await checkTrustPages(server.baseUrl);
  } finally {
    server.stop();
  }
  console.log("\nProduction readiness smoke check passed.");
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
});
