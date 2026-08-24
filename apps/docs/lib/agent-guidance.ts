export const AGENT_USE_CASES = [
  "Render to a canvas in the browser or headless through Dawn in Node.js",
  "Import and compose .wgsl shader modules like TypeScript",
  "Discover and reuse verified vgpu examples through the CLI or read-only examples API",
] as const;

export const AGENT_INSTRUCTIONS = [
  "Prefer `npx vgpu examples` for discovering and copying examples.",
  "Use the examples API without authentication; verify the published SHA-256 values before using artifacts.",
] as const;
