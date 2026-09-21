import { ExamplesCache } from "@vgpu/cli/lib/examples/cache.js";
import { ExamplesClient } from "@vgpu/cli/lib/examples/client.js";
import type { ArtifactReadOptions, StoredArtifact } from "../examples-api/artifact-store";

type ReadMutable = (key: string, options?: ArtifactReadOptions) => Promise<StoredArtifact | undefined>;
type ReadRevision = (revision: string, key: string, options?: ArtifactReadOptions) => Promise<StoredArtifact | undefined>;
const MCP_ARTIFACT_CACHE_BYTES = 8 * 1024 * 1024;

interface ArtifactExamplesSourceOptions {
  readonly baseUrl?: string;
  readonly version: string;
  readonly readMutable: ReadMutable;
  readonly readRevision: ReadRevision;
  readonly now?: () => Date;
}

/**
 * Adapts the deployment's verified artifact store to the CLI's existing examples client. The
 * client still owns schema, origin, revision, and checksum validation; only its fetch boundary is
 * replaced, so the server never calls its own public HTTP routes.
 */
export function createArtifactExamplesSource({
  baseUrl = "https://vgpu.sh",
  version,
  readMutable,
  readRevision,
  now,
}: ArtifactExamplesSourceOptions) {
  const fetchImpl = createArtifactFetch({ baseUrl, readMutable, readRevision });
  return new ExamplesClient({
    baseUrl,
    fetchImpl,
    // This source lives for the warm function lifetime. Bound historical-revision churn while
    // retaining enough verified data for several ordinary example reads.
    cache: new ExamplesCache("vgpu-mcp-memory", {
      persistent: false,
      maxMemoryBytes: MCP_ARTIFACT_CACHE_BYTES,
    }),
    cliVersion: version,
    now,
  });
}

function createArtifactFetch({
  baseUrl,
  readMutable,
  readRevision,
}: {
  baseUrl: string;
  readMutable: ReadMutable;
  readRevision: ReadRevision;
}): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (url.origin !== origin || url.search || url.hash || /[%\\\0-\x1f\x7f]/u.test(url.pathname)) {
      return new Response(null, { status: 404 });
    }

    const target = artifactTarget(url.pathname);
    if (!target) return new Response(null, { status: 404 });
    const stored = await readWithSignal(request.signal, () => target.revision
      ? readRevision(target.revision, target.key, { signal: request.signal })
      : readMutable(target.key, { signal: request.signal }));
    if (!stored) return new Response(null, { status: 404 });

    const etag = `"${stored.sha256}"`;
    const headers = new Headers({
      "content-type": stored.contentType,
      "content-length": String(stored.bytes.byteLength),
      etag,
    });
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(Uint8Array.from(stored.bytes).buffer, { status: 200, headers });
  };
}

async function readWithSignal<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    return await Promise.race([read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function artifactTarget(pathname: string): { key: string; revision?: string } | undefined {
  if (pathname === "/.well-known/vgpu-examples.json") return { key: pathname.slice(1) };
  const key = pathname.startsWith("/api/") ? pathname.slice(5) : pathname.slice(1);
  if (key === "examples/v1/latest.json") return { key };
  const match = /^examples\/v1\/revisions\/([a-f0-9]{64})\/(.+)$/u.exec(key);
  return match ? { key, revision: match[1] } : undefined;
}
