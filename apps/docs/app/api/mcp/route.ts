import { createDocsService } from "@vgpu/cli/lib/docs/service.js";
import { createExamplesService } from "@vgpu/cli/lib/examples/service.js";
import { createRequire } from "node:module";
import { readMutableArtifact, readRevisionArtifact } from "../../../lib/examples-api/artifact-store";
import { createArtifactExamplesSource } from "../../../lib/mcp/artifact-examples-source";
import { createVgpuMcpHttpHandler } from "../../../lib/mcp/http-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const nodeRequire = createRequire(import.meta.url);
const publicPackage = nodeRequire("vgpu/package.json") as { version: string };
const docs = createDocsService();
const source = createArtifactExamplesSource({
  version: publicPackage.version,
  readMutable: readMutableArtifact,
  readRevision: readRevisionArtifact,
});
const examples = createExamplesService({ source });
const handler = createVgpuMcpHttpHandler({
  version: publicPackage.version,
  docs,
  examples,
  allowedOriginHostnames: ["vgpu.sh", "vgpu.labs.vercel.dev"],
  onerror: (error) => console.error("vgpu MCP request error", error),
});

export const GET = (request: Request) => handler.fetch(request);
export const POST = GET;
export const DELETE = GET;
