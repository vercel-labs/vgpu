import { readRevisionArtifact } from '../../../../../../../lib/examples-api/artifact-store';
import { artifactResponse, methodNotAllowedResponse, optionsResponse } from '../../../../../../../lib/examples-api/http-response';
import { IMMUTABLE_CACHE_CONTROL, revisionArtifactKey } from '../../../../../../../lib/examples-api/route-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ revision: string; artifact: string[] }> };

async function serve(request: Request, method: 'GET' | 'HEAD', context: RouteContext): Promise<Response> {
  const { revision, artifact } = await context.params;
  const key = revisionArtifactKey(revision, artifact);
  return artifactResponse(
    request,
    method,
    () => key ? readRevisionArtifact(revision, key) : Promise.resolve(undefined),
    IMMUTABLE_CACHE_CONTROL,
  );
}

export const GET = (request: Request, context: RouteContext) => serve(request, 'GET', context);
export const HEAD = (request: Request, context: RouteContext) => serve(request, 'HEAD', context);
export const OPTIONS = (_request: Request) => optionsResponse();
export const POST = (_request: Request, _context: RouteContext) => methodNotAllowedResponse();
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
