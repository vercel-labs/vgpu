import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactResponse } from './http-response';
import type { StoredArtifact } from './artifact-store';

const request = (path: string, headers?: HeadersInit) => new Request(`https://vgpu.sh${path}`, { headers });
const cacheControl = 'public, max-age=60, must-revalidate';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('artifactResponse storage failures', () => {
  it('records the underlying cause server-side while keeping the opaque 500 contract', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const load = () => Promise.reject(new Error('Missing VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN'));

    const response = await artifactResponse(request('/api/examples/v1/latest.json'), 'GET', load, cacheControl);

    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({
      error: { code: 'VGPU-EXAMPLES-STORAGE', message: 'Artifact storage verification failed' },
    });

    expect(errors).toHaveBeenCalledTimes(1);
    const [logged] = errors.mock.calls[0] as [string];
    expect(logged).toContain('VGPU-EXAMPLES-STORAGE');
    expect(logged).toContain('GET /api/examples/v1/latest.json');
    expect(logged).toContain('Error: Missing VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN');
  });

  it('distinguishes the other storage conditions in the log line', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const causes = [
      new Error('Unsupported VGPU_EXAMPLES_ARTIFACT_STORE: vercel-blob'),
      new Error('Stored artifact integrity mismatch: examples/v1/revisions/abc/index.json'),
      new Error('Stored revision manifest is invalid JSON'),
      'plain string rejection',
    ];

    for (const cause of causes) {
      const response = await artifactResponse(request('/.well-known/vgpu-examples.json'), 'HEAD', () => Promise.reject(cause), cacheControl);
      expect(response.status).toBe(500);
    }

    const logged = errors.mock.calls.map(([line]) => line as string);
    expect(logged).toHaveLength(causes.length);
    expect(logged[0]).toContain('Unsupported VGPU_EXAMPLES_ARTIFACT_STORE: vercel-blob');
    expect(logged[1]).toContain('Stored artifact integrity mismatch');
    expect(logged[2]).toContain('Stored revision manifest is invalid JSON');
    expect(logged[3]).toContain('plain string rejection');
    expect(logged.every((line) => line.startsWith('VGPU-EXAMPLES-STORAGE HEAD /.well-known/vgpu-examples.json'))).toBe(true);
  });

  it('does not log for a missing artifact, which stays a 404', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await artifactResponse(request('/api/examples/v1/latest.json'), 'GET', () => Promise.resolve(undefined), cacheControl);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: 'VGPU-EXAMPLES-NOT-FOUND', message: 'Artifact not found' },
    });
    expect(errors).not.toHaveBeenCalled();
  });

  it('does not log on the success and 304 paths', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const bytes = new TextEncoder().encode('{"ok":true}\n');
    const artifact: StoredArtifact = { bytes, contentType: 'application/json; charset=utf-8', sha256: 'a'.repeat(64) };

    const ok = await artifactResponse(request('/api/examples/v1/latest.json'), 'GET', () => Promise.resolve(artifact), cacheControl);
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(bytes);

    const etag = `"${artifact.sha256}"`;
    const notModified = await artifactResponse(request('/api/examples/v1/latest.json', { 'if-none-match': etag }), 'GET', () => Promise.resolve(artifact), cacheControl);
    expect(notModified.status).toBe(304);
    expect(errors).not.toHaveBeenCalled();
  });
});
