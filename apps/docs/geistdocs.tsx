import type { GeistdocsAgentReadinessConfig } from "@vercel/geistdocs/config";
import { VgpuWordmark } from "./components/vgpu-wordmark";
import { AGENT_INSTRUCTIONS, AGENT_USE_CASES } from "./lib/agent-guidance";

// TGEIST-11 follow-up (branding sweep): this whole file is the scaffold
// template's placeholder content (TGEIST-01 explicitly told this ticket NOT
// to copy `eve/apps/docs`'s geistdocs.tsx verbatim -- "usarlos solo como
// forma, no como contenido" -- so the scaffold shipped the template's own
// generic "Geistdocs" copy instead, unfixed until now). Every string here is
// user-visible (nav logo, GitHub button/edit links, RSS/sitemap title, AI
// chat system prompt, agent-readiness manifest) so it all becomes vgpu's real
// branding, sourced verbatim from apps/docs/app/layout.tsx where it overlaps.
export const Logo = () => (
  <VgpuWordmark
    aria-label="vgpu"
    className="text-gray-1000 h-[1.125rem] w-[2.9rem] fill-current"
  />
);

export const github = {
  branch: "canary",
  // The real path from the repo root, not from this app: vgpu is a monorepo,
  // content/docs lives under apps/docs, and the vanilla template's path
  // (content/docs/{path}) pointed "edit this page" at a 404.
  editPath: "apps/docs/content/docs/{path}",
  owner: "vercel-labs",
  repo: "vgpu",
};

export const nav = [
  {
    label: "Docs",
    href: "/docs",
  },
  {
    label: "Examples",
    href: "/examples",
  },
];

export const suggestions = [
  "What is vgpu?",
  "How do I render to a canvas with vgpu?",
  "How do I run vgpu headless in Node.js?",
  "How do I import a .wgsl file?",
];

export const title = "vgpu";

export const navbarVariant = "standard" as const;

export const prompt =
  "You are a helpful assistant specializing in answering questions about vgpu, an agentic-first WebGPU library for Node, browsers, and serverless runtimes.";

export const agent = {
  product: {
    name: "vgpu",
    description:
      "vgpu is a small, composable WebGPU library -- one API for rendering in the browser and headless in Node.js, with WGSL modules you import like TypeScript.",
    category: "Developer tools",
    audience: ["Coding agents", "WebGPU and graphics developers"],
    useCases: [...AGENT_USE_CASES],
  },
  links: [
    {
      label: "vgpu source",
      href: `https://github.com/${github.owner}/${github.repo}`,
      description: "Source repository for vgpu",
    },
    {
      label: "vgpu on npm",
      href: "https://www.npmjs.com/package/vgpu",
      description: "Published vgpu package",
    },
    {
      label: "CLI documentation",
      href: "https://vgpu.sh/docs/cli",
      description: "Commands for docs, examples, diagnostics, and rendering",
    },
    {
      label: "Examples discovery",
      href: "https://vgpu.sh/.well-known/vgpu-examples.json",
      description: "Tokenless discovery document for the read-only examples API",
    },
    {
      label: "MCP endpoint",
      href: "https://vgpu.sh/api/mcp",
      description: "Stateless, read-only MCP tools for VGPU documentation and verified examples",
    },
  ],
  api: {
    openApiUrl: "https://vgpu.sh/openapi.json",
    openApiSpecs: [
      {
        label: "Examples API",
        url: "https://vgpu.sh/openapi.json",
        description: "OpenAPI 3.1 for examples discovery, indexes, and manifests",
      },
    ],
    errorsUrl: "https://vgpu.sh/docs/examples-api#errors",
  },
  mcp: {
    manifestUrl: "/.well-known/mcp.json",
    servers: [
      {
        name: "vgpu MCP",
        url: "https://vgpu.sh/api/mcp",
        description: "Stateless modern MCP tools for searching VGPU documentation and verified examples.",
      },
    ],
  },
  instructions: [...AGENT_INSTRUCTIONS],
} satisfies GeistdocsAgentReadinessConfig;

export const translations = {
  en: {
    displayName: "English",
  },
  cn: {
    displayName: "Chinese",
    search: "搜尋文檔",
  },
};

export const basePath: string | undefined = undefined;

/**
 * Unique identifier for this site, used in markdown request tracking analytics.
 * Each site using geistdocs should set this to a unique value (e.g. "ai-sdk-docs", "next-docs").
 */
export const siteId: string | undefined = undefined;
