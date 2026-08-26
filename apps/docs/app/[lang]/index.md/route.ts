import { applyMarkdownHeaders } from "@vercel/agent-readability";
import { homepageDiscoveryLinkHeader, siteUrl } from "../../../lib/site";

export const revalidate = false;

export const homepageMarkdown = `# vgpu

vgpu is the WebGPU library designed for agents: one small, composable API for browser canvases, headless Node.js, and serverless runtimes.

## Install

\`\`\`bash
pnpm add vgpu
\`\`\`

Run the CLI without installing it globally:

\`\`\`bash
npx vgpu
\`\`\`

## Start here

- [Documentation](/docs)
- [Getting started](/docs/get-started)
- [CLI reference](/docs/cli)
- [MCP reference](/docs/mcp)
- [Interactive examples](/examples)
- [Examples API reference](/docs/examples-api)

Agents can connect directly to the hosted, read-only MCP server at [/api/mcp](/api/mcp). The preferred human CLI for discovering and copying examples is \`npx vgpu examples\`. The existing tokenless, read-only examples discovery API is available at [/.well-known/vgpu-examples.json](/.well-known/vgpu-examples.json), with its OpenAPI 3.1 description at [/openapi.json](/openapi.json).

## Agent resources

- [Agent readiness manifest](/agents.md)
- [Agent documentation index](/llms.txt)
- [Complete documentation export](/llms-full.txt)
- [Markdown sitemap](/sitemap.md)
- [XML sitemap](/sitemap.xml)

Source is available on [GitHub](https://github.com/vercel-labs/vgpu), and the package is published as [vgpu on npm](https://www.npmjs.com/package/vgpu).
`;

export function GET(): Response {
  const headers = applyMarkdownHeaders(
    new Headers({ "Content-Type": "text/markdown; charset=utf-8" }),
    { canonicalUrl: siteUrl("/") },
  );
  headers.append("Link", homepageDiscoveryLinkHeader);
  return new Response(homepageMarkdown, { headers });
}
