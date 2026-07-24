import type { StoredArtifact } from './artifact-store';

export type ReadMethod = 'GET' | 'HEAD';
export type ArtifactLoader = () => Promise<StoredArtifact | undefined>;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'If-None-Match',
  'Access-Control-Expose-Headers': 'ETag, Content-Length',
  'X-Content-Type-Options': 'nosniff',
} as const;

export async function artifactResponse(
  request: Request,
  method: ReadMethod,
  load: ArtifactLoader,
  cacheControl: string,
): Promise<Response> {
  let artifact: StoredArtifact | undefined;
  try {
    artifact = await load();
  } catch {
    return errorResponse(500, 'VGPU-EXAMPLES-STORAGE', 'Artifact storage verification failed');
  }
  if (!artifact) return errorResponse(404, 'VGPU-EXAMPLES-NOT-FOUND', 'Artifact not found');

  const etag = `"${artifact.sha256}"`;
  const headers = new Headers({
    ...CORS_HEADERS,
    'Cache-Control': cacheControl,
    'Content-Type': artifact.contentType,
    'Content-Length': String(artifact.bytes.byteLength),
    ETag: etag,
  });
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  return new Response(method === 'HEAD' ? null : Buffer.from(artifact.bytes), { status: 200, headers });
}

export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function methodNotAllowedResponse(): Response {
  const response = errorResponse(405, 'VGPU-EXAMPLES-METHOD-NOT-ALLOWED', 'Only GET, HEAD, and OPTIONS are allowed');
  response.headers.set('Allow', 'GET, HEAD, OPTIONS');
  return response;
}

function errorResponse(status: number, code: string, message: string): Response {
  const body = `${JSON.stringify({ error: { code, message } })}\n`;
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    },
  });
}

function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value === etag || value === `W/${etag}`;
  });
}
