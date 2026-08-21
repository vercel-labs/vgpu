import { applyMarkdownHeaders } from "@vercel/agent-readability";
import { siteUrl } from "../../../lib/site";

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
- [Interactive examples](/examples)
- [Examples API reference](/docs/examples-api)

The preferred way to discover and copy examples is \`npx vgpu examples\`. The existing tokenless, read-only examples discovery API is available at [/.well-known/vgpu-examples.json](/.well-known/vgpu-examples.json), with its OpenAPI 3.1 description at [/openapi.json](/openapi.json).

## Agent resources

- [Agent readiness manifest](/agents.md)
- [Complete documentation export](/llms.txt)
- [Markdown sitemap](/sitemap.md)
- [XML sitemap](/sitemap.xml)

Source is available on [GitHub](https://github.com/vercel-labs/vgpu), and the package is published as [vgpu on npm](https://www.npmjs.com/package/vgpu).
`;

export function GET(): Response {
  const headers = applyMarkdownHeaders(
    new Headers({ "Content-Type": "text/markdown; charset=utf-8" }),
    { canonicalUrl: siteUrl("/") },
  );
  return new Response(homepageMarkdown, { headers });
}
