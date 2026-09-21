export const AGENT_USE_CASES = [
  "Render to a canvas in the browser or headless through Dawn in Node.js",
  "Import and compose .wgsl shader modules like TypeScript",
  "Discover and reuse verified vgpu examples through the CLI or read-only examples API",
  "Give coding agents direct MCP tools for vgpu documentation and verified examples",
] as const;

export const AGENT_INSTRUCTIONS = [
  "Prefer `npx vgpu examples` for discovering and copying examples.",
  "Use the examples API without authentication; verify the published SHA-256 values before using artifacts.",
  "Use the public MCP server with automatic or modern protocol negotiation for current stable documentation and example discovery.",
  "Use the project-local vgpu CLI or MCP server when documentation must match an installed package or prerelease.",
  "Use `npx vgpu mcp --project-from-cwd` for an active project workspace or `npx vgpu mcp --output-dir /absolute/path` for a fixed project when a local agent needs downloads.",
  "When download is enabled, pass a relative `destination` beneath the configured output directory.",
] as const;
