# Examples API operations

The examples API exposes exact canonical gallery bytes from the permanent origin `https://vgpu.labs.vercel.dev`. Version 1 is read-only, tokenless, same-origin, and contains no dynamic search endpoint.

## Routes and HTTP contract

| Route | Object | Cache policy |
| --- | --- | --- |
| `/.well-known/vgpu-examples.json` | discovery and contract negotiation | `public, max-age=60, must-revalidate` |
| `/api/examples/v1/latest.json` | mutable revision pointer | `public, max-age=60, must-revalidate` |
| `/api/examples/v1/revisions/<sha256>/<artifact>` | retained index, manifests, revision manifest, and raw files | `public, max-age=31536000, immutable` |

Handlers support only `GET`, `HEAD`, and `OPTIONS`; other methods return 405. They return wildcard CORS without credentials, strong SHA-256 `ETag`, `Content-Length`, `X-Content-Type-Options: nosniff`, exact JSON or text content types, and 304 for matching `If-None-Match`. Requests never redirect. Revision paths must match an allowlisted object in that revision's retained manifest; there is no listing, mutation, or search route.

Response caps are 32 KiB for discovery/latest, 1 MiB for index/revision documents, 256 KiB for example manifests, and 2 MiB per source file. Raw storage keys end in `.raw`; manifest `path` values remain the authored names and response bytes are unchanged.

## Publication transaction

`node apps/docs/scripts/generate-examples-api.mjs --publish` performs this transaction:

1. deterministically generate the artifact set;
2. create every revision object with overwrite disabled;
3. fresh-read and verify size, content type, and SHA-256 for every retained object;
4. update and verify discovery;
5. verify the new index → `raymarched-fractal` manifest → raw file through the already-successful docs deployment;
6. overwrite `examples/v1/latest.json` last;
7. fresh-read latest without cache and verify its size, content type, and SHA-256 before reporting success.

A failed create or pre-pointer verification leaves latest unchanged. A failed post-write latest verification fails publication loudly so operators do not treat an unverified pointer as successful. Retrying is safe only when the retained object is byte-identical. Revisions are never deleted or overwritten.

Run `.github/workflows/publish-examples-api.yml` manually only after the matching docs commit has deployed successfully. Supply that successful deployment's URL as `deployment_url`; the workflow performs pre-pointer verification there and then verifies the official discovery chain after latest advances.

## One-time production setup

1. In the Vercel team owning the docs project, create a **public Vercel Blob store** and connect it to the docs project.
2. Disable every expiration/automatic-deletion lifecycle policy. Revision objects are permanent retained protocol state.
3. Create the GitHub environment `examples-api-production`. Add secret `VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN` with the store's read/write token.
4. Add environment variables `VGPU_EXAMPLES_ORIGIN=https://vgpu.labs.vercel.dev` and `VGPU_EXAMPLES_BLOB_PREFIX=examples/v1` to that GitHub environment.
5. Add production variables to the Vercel docs project: `VGPU_EXAMPLES_ARTIFACT_STORE=blob` and `VGPU_EXAMPLES_VERCEL_BLOB_READ_WRITE_TOKEN=<same store token>`. Preview/local production builds must explicitly use `VGPU_EXAMPLES_ARTIFACT_STORE=local` and `VGPU_EXAMPLES_LOCAL_ROOT=<absolute generated tree>` instead.
6. Ensure `vgpu.labs.vercel.dev` targets this same docs deployment. The v1 discovery, latest, and revision responses must remain on this host.
7. Deploy docs first. Then run the publisher workflow with its `VERCEL_DEPLOYMENT_URL`. The adapter-v1 all-ten parity gate and integration approval were completed before enabling this step.

The generator now consumes the canonical adapter-v1 export. `--publish` still requires `VERCEL_DEPLOYMENT_URL` and the configured Vercel Blob credentials; immutable verification and the latest-pointer-last transaction remain mandatory.

Production will intentionally return a storage error if Blob mode is selected without the exact token; it does not silently fall back to deployment files.

## Rollback

Rollback changes only `examples/v1/latest.json`; never remove or alter retained revision objects. Select a previously verified revision, fetch its immutable `index.json`, recompute its SHA-256, construct the strict latest document with that revision, official immutable `indexUrl`, and `indexSha256`, then overwrite only the latest Blob key with `allowOverwrite: true`, `addRandomSuffix: false`, and a 60-second cache age. Fresh-read the pointer and verify the official discovery → latest → index chain. Keep discovery unchanged unless contract status itself changes.

A rollback cannot point at a revision whose immutable index and complete object graph have not been fresh-read and hash-verified. Record the old/new revision, index hash, workflow run, and verification transcript in the incident log.

## Local serving

```sh
node apps/docs/scripts/generate-examples-api.mjs
pnpm --filter docs build
VGPU_EXAMPLES_ARTIFACT_STORE=local \
VGPU_EXAMPLES_LOCAL_ROOT="$PWD/apps/docs/generated/examples-api" \
pnpm --filter docs exec next start --port 3013
```

No Blob credential is required in explicit local mode. Stop the scratch server after verification.
