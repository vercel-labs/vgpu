import { readMutableArtifact } from '../../../lib/examples-api/artifact-store';
import { artifactResponse, methodNotAllowedResponse, optionsResponse } from '../../../lib/examples-api/http-response';
import { DISCOVERY_ARTIFACT_KEY, MUTABLE_CACHE_CONTROL } from '../../../lib/examples-api/route-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const read = () => readMutableArtifact(DISCOVERY_ARTIFACT_KEY);
export const GET = (request: Request) => artifactResponse(request, 'GET', read, MUTABLE_CACHE_CONTROL);
export const HEAD = (request: Request) => artifactResponse(request, 'HEAD', read, MUTABLE_CACHE_CONTROL);
export const OPTIONS = (_request: Request) => optionsResponse();
export const POST = (_request: Request) => methodNotAllowedResponse();
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
