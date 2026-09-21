import { createServer } from "node:http";
import { EXAMPLES_SCHEMA_SHA256 } from "../lib/examples/contracts.js";
import { aggregateSha256, sha256 } from "../lib/examples/hashing.js";

export async function startExamplesFixture() {
  const revision = "1".repeat(64);
  const source = Buffer.from("export const answer = 42;\n");
  let discovery: Buffer;
  let pointer: Buffer;
  let index: Buffer;
  let manifest: Buffer;
  const server = createServer((request, response) => {
    const send = (body: Buffer, contentType = "application/json; charset=utf-8") => {
      response.setHeader("content-type", contentType);
      response.setHeader("content-length", String(body.byteLength));
      response.end(body);
    };
    if (request.url === "/.well-known/vgpu-examples.json") return send(discovery);
    if (request.url === "/api/examples/v1/latest.json") return send(pointer);
    if (request.url === `/examples/v1/revisions/${revision}/index.json`) return send(index);
    if (request.url?.endsWith("/manifest.json")) return send(manifest);
    if (request.url?.endsWith("/example.ts.raw")) return send(source, "text/typescript");
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const file = {
    path: "example.ts",
    contentType: "text/typescript",
    size: source.byteLength,
    sha256: sha256(source),
    url: `${origin}/examples/v1/revisions/${revision}/examples/gradient/files/example.ts.raw`,
  };
  const manifestValue = {
    schemaVersion: 1,
    contractId: "vgpu-examples/v1",
    revision,
    id: "gradient",
    title: "Gradient",
    description: "A verified gradient.",
    tags: ["gradient"],
    capabilities: [],
    aggregateSha256: "",
    files: [file],
  };
  manifestValue.aggregateSha256 = aggregateSha256(manifestValue);
  manifest = Buffer.from(JSON.stringify(manifestValue));
  const entry = {
    id: manifestValue.id,
    title: manifestValue.title,
    description: manifestValue.description,
    tags: manifestValue.tags,
    capabilities: manifestValue.capabilities,
    fileCount: 1,
    aggregateSha256: manifestValue.aggregateSha256,
    manifestUrl: `${origin}/examples/v1/revisions/${revision}/examples/gradient/manifest.json`,
    manifestSha256: sha256(manifest),
  };
  index = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    contractId: "vgpu-examples/v1",
    revision,
    source: { repository: "vgpu-test", gitCommit: "test" },
    examples: [entry],
  }));
  pointer = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    contractId: "vgpu-examples/v1",
    revision,
    indexUrl: `${origin}/examples/v1/revisions/${revision}/index.json`,
    indexSha256: sha256(index),
  }));
  discovery = Buffer.from(JSON.stringify({
    protocol: "vgpu-examples",
    discoveryVersion: 1,
    contracts: [{
      id: "vgpu-examples/v1",
      schemaSha256: EXAMPLES_SCHEMA_SHA256,
      status: "active",
      minimumCliVersion: "0.1.0",
      indexUrl: `${origin}/api/examples/v1/latest.json`,
    }],
  }));

  return {
    origin,
    source,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}
