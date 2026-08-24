import { localizedSiteUrl, siteUrl } from "./site";
import { AGENT_INSTRUCTIONS, AGENT_USE_CASES } from "./agent-guidance";

function markdownList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export function buildLlmsIndexMarkdown(lang = "en"): string {
  const markdownUrl = (path: string) => localizedSiteUrl(path, lang);

  return `# vgpu

> vgpu is a small, composable WebGPU library for browser canvases, headless Node.js, and serverless runtimes, with documentation and tooling designed for coding agents.

Use the focused Markdown pages below first. Fetch the full export only when a task requires broad repository context.

## When to use vgpu

Use vgpu when a coding agent needs to:

${markdownList(AGENT_USE_CASES)}

Agent workflow:

${markdownList(AGENT_INSTRUCTIONS)}

## Start here

- [Agent quickstart](${markdownUrl("/docs/get-started/agents.md")}): Discover the versioned docs and tools available through the vgpu CLI.
- [Web quickstart](${markdownUrl("/docs/get-started/web.md")}): Render to a browser canvas and configure WGSL imports.
- [Node.js quickstart](${markdownUrl("/docs/get-started/node.md")}): Render headlessly through Dawn for scripts, servers, and tests.

## Reference

- [CLI reference](${markdownUrl("/docs/cli.md")}): Commands for docs, examples, validation, diagnostics, and snapshots.
- [Library API reference](${markdownUrl("/docs/reference.md")}): Package map and generated API topic pages.
- [Interactive examples](${markdownUrl("/examples")}): Live WebGPU examples with read-only source views.
- [vgpu Examples API](${markdownUrl("/docs/examples-api.md")}): Tokenless, read-only discovery for immutable example artifacts.

## Machine interfaces

- [Agent readiness manifest](${markdownUrl("/agents.md")}): Product identity, CLI, package, and API discovery metadata.
- [OpenAPI 3.1 description](${siteUrl("/openapi.json")}): Typed examples API operations and response schemas.
- [API catalog](${siteUrl("/.well-known/api-catalog")}): RFC 9727 discovery for the examples API.
- [Markdown sitemap](${markdownUrl("/sitemap.md")}): Complete page index.

## Optional

- [Complete documentation export](${markdownUrl("/llms-full.txt")}): All documentation concatenated as Markdown for bulk ingestion.
- [XML sitemap](${siteUrl("/sitemap.xml")}): Canonical indexable URLs.
- [Source repository](https://github.com/vercel-labs/vgpu): Source, issues, releases, and contribution history.
- [vgpu on npm](https://www.npmjs.com/package/vgpu): Published package and CLI.
`;
}
