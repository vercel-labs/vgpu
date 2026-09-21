#!/usr/bin/env node
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READY_TIMEOUT_MS = 120_000;
const CANONICAL_ORIGIN = "https://vgpu.sh";
const DEPLOYMENT_ALIAS = "vgpu.labs.vercel.dev";
const require = createRequire(import.meta.url);
const PUBLIC_PACKAGE_VERSION = require("vgpu/package.json").version;
const HOMEPAGE_DISCOVERY_LINKS = [
  '<https://vgpu.sh/index.md>; rel="alternate"; type="text/markdown"',
  '<https://vgpu.sh/llms.txt>; rel="describedby"; type="text/markdown"',
  '<https://vgpu.sh/sitemap.xml>; rel="sitemap"; type="application/xml"',
  '<https://vgpu.sh/openapi.json>; rel="service-desc"; type="application/json"',
  '<https://vgpu.sh/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
];

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
  assert(
    html.match(/<h([1-6])\b/iu)?.[1] === "1",
    "homepage: navigation heading appears before the page h1",
  );
  assert(visibleText(html).length >= 500, `homepage: only ${visibleText(html).length} visible SSR characters`);
  assert(html.includes('<link rel="canonical" href="https://vgpu.sh"'), "homepage: canonical metadata is missing");
  for (const property of ["og:type", "og:title", "og:description", "og:url", "og:image"]) {
    assert(html.includes(`property="${property}"`), `homepage: ${property} is missing`);
  }
  assert(html.includes("https://vgpu.sh/hero/og.webp"), "homepage: canonical OG image URL is missing");
  assert(html.includes("/docs/examples-api"), "homepage: examples API reference is not discoverable");
  assert(html.includes("/openapi.json"), "homepage: OpenAPI description is not discoverable");
  for (const trustPath of ["/about", "/contact"]) {
    assert(html.includes(`href="${trustPath}"`), `homepage footer: ${trustPath} is not discoverable`);
  }

  const linkHeader = response.headers.get("link") ?? "";
  for (const expected of HOMEPAGE_DISCOVERY_LINKS) {
    assert(linkHeader.includes(expected), `homepage: Link header is missing ${expected}`);
  }

  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/iu);
  assert(jsonLdMatch, "homepage: JSON-LD is missing from server HTML");
  const jsonLd = JSON.parse(jsonLdMatch[1]);
  const types = jsonLd["@graph"].map((entry) => entry["@type"]);
  assert(types.includes("WebSite") && types.includes("SoftwareSourceCode"), "homepage: JSON-LD entities are incomplete");
  const jsonLdText = JSON.stringify(jsonLd);
  for (const identity of ["https://github.com/vercel-labs/vgpu", "https://www.npmjs.com/package/vgpu"]) {
    assert(jsonLdText.includes(identity), `homepage: JSON-LD sameAs is missing ${identity}`);
  }
  assert(!html.includes(DEPLOYMENT_ALIAS), "homepage: deployment alias leaked into metadata");
  console.log("  ok  homepage SSR, canonical, Open Graph, and JSON-LD");
}

async function checkMarkdown(baseUrl) {
  const negotiated = await request(baseUrl, "/", { headers: { Accept: "text/markdown" } });
  const negotiatedBody = await negotiated.text();
  assertMarkdownResponse(negotiated, "negotiated homepage");
  const negotiatedLinks = negotiated.headers.get("link") ?? "";
  assert(negotiatedLinks.includes('<https://vgpu.sh/>; rel="canonical"'), "negotiated homepage: canonical Link is wrong");
  for (const expected of HOMEPAGE_DISCOVERY_LINKS) {
    assert(negotiatedLinks.includes(expected), `negotiated homepage: Link header is missing ${expected}`);
  }

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
  assert(missingBody.includes("/llms.txt"), "missing docs Markdown: agent index link is missing");

  const missingPage = await request(baseUrl, "/definitely-missing-agent-readiness", {
    headers: { Accept: "text/markdown" },
  });
  const missingPageBody = await missingPage.text();
  assertMarkdownResponse(missingPage, "missing page Markdown", 404);
  for (const expected of ["# Page Not Found", "/llms.txt", "/llms-full.txt", "/sitemap.md"]) {
    assert(missingPageBody.includes(expected), `missing page Markdown: recovery body is missing ${expected}`);
  }

  const examplesHtml = await request(baseUrl, "/examples", { headers: { Accept: "text/markdown" } });
  assert(examplesHtml.status === 200, `examples Markdown preference fallback: status ${examplesHtml.status}`);
  assert(
    examplesHtml.headers.get("content-type")?.includes("text/html"),
    "examples Markdown preference fallback: valid app page was replaced",
  );

  const examplePage = await request(baseUrl, "/examples/gradient", { headers: { Accept: "text/html" } });
  const examplePageBody = await examplePage.text();
  assert(examplePage.status === 200, `example HTML: status ${examplePage.status}`);
  assert(
    examplePageBody.includes('<link rel="alternate" type="text/markdown" href="https://vgpu.sh/examples/gradient.md"'),
    "example HTML: Markdown alternate is missing",
  );

  const negotiatedExample = await request(baseUrl, "/examples/gradient", { headers: { Accept: "text/markdown" } });
  assertMarkdownResponse(negotiatedExample, "negotiated example Markdown");
  const negotiatedExampleBody = await negotiatedExample.text();
  assert(negotiatedExampleBody.includes("# Simple Gradient"), "negotiated example Markdown: README title is missing");
  assert(
    negotiatedExampleBody.includes("npx vgpu examples pull gradient --out ./gradient"),
    "negotiated example Markdown: download command is missing",
  );

  const explicitExample = await request(baseUrl, "/examples/gradient.md");
  assertMarkdownResponse(explicitExample, "explicit example Markdown");
  const explicitExampleBody = await explicitExample.text();
  assert(
    explicitExampleBody === negotiatedExampleBody,
    "explicit and negotiated example Markdown differ",
  );
  assert(
    explicitExample.headers.get("link")?.includes("<https://vgpu.sh/examples/gradient>; rel=\"canonical\""),
    "explicit example Markdown: canonical Link is missing",
  );
  assert(
    explicitExampleBody.includes("https://vgpu.sh/examples/gradient/source.md"),
    "explicit example Markdown: complete source link is missing",
  );

  const explicitExampleSource = await request(baseUrl, "/examples/gradient/source.md");
  assertMarkdownResponse(explicitExampleSource, "explicit example source Markdown");
  const explicitExampleSourceBody = await explicitExampleSource.text();
  for (const expected of ["# Simple Gradient source", "## `index.tsx`", "## `renderer.ts`", "## `shader.wgsl`"]) {
    assert(
      explicitExampleSourceBody.includes(expected),
      `explicit example source Markdown: missing ${expected}`,
    );
  }

  const negotiatedExampleSource = await request(baseUrl, "/examples/gradient/source", {
    headers: { Accept: "text/markdown" },
  });
  assertMarkdownResponse(negotiatedExampleSource, "negotiated example source Markdown");
  assert(
    await negotiatedExampleSource.text() === explicitExampleSourceBody,
    "explicit and negotiated example source Markdown differ",
  );

  const missingExample = await request(baseUrl, "/examples/not-a-real-example", {
    headers: { Accept: "text/markdown" },
  });
  assertMarkdownResponse(missingExample, "missing example Markdown", 404);

  const agentMissing = await request(baseUrl, "/definitely-missing-agent-readiness", {
    headers: { "User-Agent": "ClaudeBot" },
  });
  assertMarkdownResponse(agentMissing, "recognized agent missing page Markdown", 404);

  const explicitDefaultLocale = await request(baseUrl, "/en/definitely-missing-agent-readiness", {
    headers: { Accept: "text/markdown" },
  });
  assert(
    [307, 308].includes(explicitDefaultLocale.status) &&
      explicitDefaultLocale.headers.get("location")?.endsWith("/definitely-missing-agent-readiness"),
    "explicit default locale: canonical redirect was replaced",
  );

  const localizedMissing = await request(baseUrl, "/cn/definitely-missing-agent-readiness", {
    headers: { Accept: "text/markdown" },
  });
  const localizedMissingBody = await localizedMissing.text();
  assertMarkdownResponse(localizedMissing, "localized missing page Markdown", 404);
  assert(localizedMissingBody.includes("/cn/llms.txt"), "localized missing page Markdown: index link is not localized");

  const trailingSlash = await request(baseUrl, "/about/", { headers: { Accept: "text/markdown" } });
  assert(
    [307, 308].includes(trailingSlash.status) && trailingSlash.headers.get("location")?.endsWith("/about"),
    "trailing-slash app page: canonical redirect was replaced",
  );
  assert(
    !trailingSlash.headers.get("content-type")?.includes("text/markdown"),
    "trailing-slash app page was replaced by Markdown 404",
  );

  const localizedDocs = await request(baseUrl, "/cn/docs/get-started/agents.md");
  assertMarkdownResponse(localizedDocs, "localized docs Markdown");
  assert(
    localizedDocs.headers.get("link")?.includes('<https://vgpu.sh/cn/llms.txt>; rel="describedby"'),
    "localized docs Markdown: describedby Link is not localized",
  );
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
  assert(openApi.headers.get("link")?.includes('rel="api-catalog"'), "OpenAPI: API catalog Link is missing");
  assert(
    openApi.headers.get("access-control-expose-headers")?.toLowerCase().split(/\s*,\s*/u).includes("link"),
    "OpenAPI: Link is not CORS-exposed",
  );

  const catalog = await request(baseUrl, "/.well-known/api-catalog");
  const catalogBody = await catalog.json();
  assert(catalog.status === 200, `API catalog: status ${catalog.status}`);
  assert(catalog.headers.get("access-control-allow-origin") === "*", "API catalog: CORS is missing");
  assert(
    catalog.headers.get("access-control-expose-headers")?.toLowerCase().split(/\s*,\s*/u).includes("link"),
    "API catalog: Link is not CORS-exposed",
  );
  assert(
    catalog.headers.get("cache-control") === "public, max-age=300, must-revalidate",
    "API catalog: cache policy changed",
  );
  assert(
    catalog.headers.get("content-type") ===
      'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
    `API catalog: wrong content type ${catalog.headers.get("content-type")}`,
  );
  const catalogText = JSON.stringify(catalogBody);
  for (const expected of ["/.well-known/vgpu-examples.json", "/openapi.json", "/docs/examples-api"]) {
    assert(catalogText.includes(expected), `API catalog: missing ${expected}`);
  }
  const catalogHead = await request(baseUrl, "/.well-known/api-catalog", { method: "HEAD" });
  assert(catalogHead.status === 200, `API catalog HEAD: status ${catalogHead.status}`);
  assert((await catalogHead.text()) === "", "API catalog HEAD: body must be empty");
  for (const header of [
    "access-control-allow-origin",
    "access-control-expose-headers",
    "cache-control",
    "content-length",
    "content-type",
    "link",
    "x-content-type-options",
  ]) {
    assert(
      catalogHead.headers.get(header) === catalog.headers.get(header),
      `API catalog HEAD: ${header} differs from GET`,
    );
  }
  assert(catalogHead.headers.get("link")?.includes('rel="api-catalog"'), "API catalog HEAD: Link is missing");

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

  const unknownApiPath = "/api/definitely-missing-agent-readiness/nested";
  const unknownApi = await request(baseUrl, unknownApiPath);
  const unknownApiJson = await unknownApi.json();
  assert(unknownApi.status === 404, `unknown API JSON 404: status ${unknownApi.status}`);
  assert(unknownApi.headers.get("content-type")?.includes("application/json"), "unknown API JSON 404: wrong content type");
  assert(unknownApi.headers.get("cache-control") === "no-store", "unknown API JSON 404: unsafe cache policy");
  assert(unknownApi.headers.get("access-control-allow-origin") === "*", "unknown API JSON 404: CORS is missing");
  assert(unknownApiJson.error?.code === "VGPU-API-NOT-FOUND", "unknown API JSON 404: code changed");
  assert(unknownApiJson.error?.message === "API endpoint not found", "unknown API JSON 404: message changed");
  assert(
    unknownApiJson.error?.resolution === "Use the OpenAPI document to find a supported endpoint.",
    "unknown API JSON 404: resolution guidance changed",
  );
  assert(
    unknownApiJson.error?.documentationUrl === "https://vgpu.sh/openapi.json",
    "unknown API JSON 404: OpenAPI recovery link changed",
  );

  const bareApi = await request(baseUrl, "/api");
  assert(
    [307, 308].includes(bareApi.status) && bareApi.headers.get("location")?.endsWith("/docs/reference"),
    "bare API: existing reference redirect changed",
  );

  const unknownApiPost = await request(baseUrl, unknownApiPath, { method: "POST" });
  assert(unknownApiPost.status === 404, `unknown API POST JSON 404: status ${unknownApiPost.status}`);
  assert(
    (await unknownApiPost.json()).error?.code === "VGPU-API-NOT-FOUND",
    "unknown API POST JSON 404: code changed",
  );

  const unknownApiHead = await request(baseUrl, unknownApiPath, { method: "HEAD" });
  assert(unknownApiHead.status === 404, `unknown API HEAD JSON 404: status ${unknownApiHead.status}`);
  assert(
    unknownApiHead.headers.get("content-length") === unknownApi.headers.get("content-length"),
    "unknown API HEAD JSON 404: content length differs from GET",
  );
  assert((await unknownApiHead.text()) === "", "unknown API HEAD JSON 404: body must be empty");
  console.log("  ok  OpenAPI, RFC 9727 catalog, discovery, and structured JSON API errors");
}

async function checkAgentResources(baseUrl) {
  const agents = await request(baseUrl, "/agents.md");
  const body = await agents.text();
  assert(agents.status === 200, `agents.md: status ${agents.status}`);
  for (const expected of ["openapi.json", "docs/cli", "npmjs.com/package/vgpu", ".well-known/vgpu-examples.json", "api/mcp"]) {
    assert(body.toLowerCase().includes(expected.toLowerCase()), `agents.md: missing ${expected}`);
  }

  const llms = await request(baseUrl, "/llms.txt");
  const llmsBody = await llms.text();
  assert(llms.status === 200 && llmsBody.startsWith("# vgpu\n\n> "), "llms.txt: v2 index header is missing");
  assert(llmsBody.length < 30_000, `llms.txt: index is too large at ${llmsBody.length} characters`);
  assert(llmsBody.includes("## When to use vgpu"), "llms.txt: explicit when-to-use guidance is missing");
  for (const expected of ["/docs/get-started/agents.md", "/openapi.json", "/llms-full.txt"]) {
    assert(llmsBody.includes(expected), `llms.txt: missing ${expected}`);
  }

  const llmsFull = await request(baseUrl, "/llms-full.txt");
  const llmsFullBody = await llmsFull.text();
  assert(llmsFull.status === 200, `llms-full.txt: status ${llmsFull.status}`);
  assert(llmsFull.headers.get("content-type")?.includes("text/markdown"), "llms-full.txt: wrong content type");
  assert(
    llmsFull.headers.get("link")?.includes('<https://vgpu.sh/llms-full.txt>; rel="canonical"'),
    "llms-full.txt: canonical Link is missing",
  );
  assert(llmsFullBody.length > 30_000, "llms-full.txt: complete corpus is unexpectedly short");
  for (const heading of ["# CLI", "# vgpu Examples API", "# API Reference"]) {
    assert(llmsFullBody.includes(heading), `llms-full.txt: representative page is missing ${heading}`);
  }

  const localizedLlmsFull = await request(baseUrl, "/cn/llms-full.txt");
  assert(
    localizedLlmsFull.headers.get("link")?.includes('<https://vgpu.sh/cn/llms-full.txt>; rel="canonical"'),
    "localized llms-full.txt: canonical Link is missing",
  );

  const mcp = await request(baseUrl, "/.well-known/mcp.json");
  const manifest = await mcp.json();
  assert(mcp.status === 200, `MCP manifest: status ${mcp.status}`);
  assert(manifest.servers?.some((server) => server.url === "https://vgpu.sh/api/mcp"), "MCP manifest: public endpoint missing");
  console.log("  ok  agent metadata advertises API, CLI, npm, and MCP");
}

async function checkMcp(baseUrl) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/api/mcp`));
  const client = new Client(
    { name: "vgpu-production-readiness", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(transport);
    assert(client.getProtocolEra() === "modern", "MCP: hosted endpoint did not negotiate the modern protocol");
    assert(client.getServerVersion()?.version === PUBLIC_PACKAGE_VERSION, "MCP: server version does not match public vgpu package");
    const listed = await client.listTools();
    assert(listed.tools.map((tool) => tool.name).join(",") === "docs,examples", "MCP: unexpected tool surface");
    const examplesTool = listed.tools.find((tool) => tool.name === "examples");
    assert(examplesTool?.annotations?.readOnlyHint === true, "MCP: public examples tool is not read-only");
    assert(!JSON.stringify(examplesTool.inputSchema).includes('"download"'), "MCP: public examples tool exposes download");

    const resolved = await client.callTool({ name: "docs", arguments: { operation: "resolve", target: "Buffer" } });
    assert(!resolved.isError, "MCP: docs resolve returned a tool error");
    assert(resolved.structuredContent?.virtualPath === "/vgpu/core/buffer.docs.md", "MCP: docs resolve returned the wrong path");

    if (process.platform === "darwin") {
      console.log("  skip MCP examples call on Darwin (fd-relative local store is Linux-only)");
    } else {
      const searched = await client.callTool({
        name: "examples",
        arguments: { operation: "search", query: "gradient" },
      });
      assert(!searched.isError, "MCP: examples search returned a tool error");
      assert(
        searched.structuredContent?.results?.some((example) => example.id === "gradient"),
        "MCP: examples search did not return the verified gradient example",
      );
    }
  } finally {
    await client.close().catch(() => undefined);
  }
  console.log("  ok  MCP discovery, public version, read-only surface, and live tool calls");
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
    await checkMcp(server.baseUrl);
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
