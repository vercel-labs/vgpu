# Native compiler release inputs

`@vgpu/native` is an optional public beta in the fixed release group. The npm `0.0.1`
bootstrap package only reserves the name and contains no operational tooling.
Do not create an npm RC until its installed candidate has been verified.

## Compiler artifact transport

The npm build must bundle the exact accepted universal Tint worker, not rebuild
Dawn during publication or download a compiler when a consumer installs the package.
The existing `source-lock.json` under
`tooling/native-tint-worker/c1-tint-direct-build/provenance/` remains the authority
for its byte length and SHA-256. Transport never changes the runtime trust list.

The transport is a separate GitHub Release in `vercel-labs/vgpu`, tagged
`native-tint-<full universal SHA-256>`, with an asset named
`vgpu-tint-worker-universal`. This tag does not start with `v`, so it cannot trigger
npm publication. The binary release must also carry the authenticated Dawn/Tint,
Abseil and JsonCpp license notices. Creating a new binary release requires maintainer
approval. The baseline selected by the current source lock is already hosted there;
verify its download from a clean checkout rather than relying on a local build.

Run `node scripts/fetch-native-worker.mjs` in a clean release checkout before packing.
The command downloads only that content-addressed asset, checks its exact length
and digest before writing, and creates the expected local worker file exclusively.
It rejects an existing destination, an HTTP failure, truncated/oversized content or
a digest mismatch. There is no fallback to a previous cached distribution. A failed
fetch must stop release preparation, not silently omit the native package.

The existing maintainer-only `prepack` authenticates the worker again and adds the
tracked license notices to the tarball. The OIDC publishing job must continue to
receive only verified tarballs, without checking out or executing repository code.

## Qualification and publication gates

The initial rollout uses two PRs. The prerequisite development PR adds transport and
explicitly allowlisted support for `@vgpu/native`, preserving historical seven-package
publication. The trusted
`release-impact` evaluator must land on `canary` first: it reads candidate data but
does not execute the candidate's updated validation code. A subsequent release PR
activates native, advances the fixed group and finalizes the migration guide. Do not
weaken the private-to-public version-change checks to bypass release preparation.
That activation must also update both workflow tarball allowlists, the publish list and exact artifact
counts, and extend production authorization's package-version and npm-evidence checks.
For historical releases, derive the supported package set from the stable candidate's
fixed group, not the latest canary configuration. Validator acceptance alone does not
prove that the publishing workflow includes the companion.

The first public companion exposes only `@vgpu/native/cli` for the existing lazy
CLI protocol. The low-level TypeScript generator remains internal; distributing
the companion does not promise a second user-facing generator API.

Before enabling the package in a release, verify installation from candidate tarballs
outside the workspace, shader compilation, generated Swift consumption, and preservation
of the existing interruption/recovery coverage. Verify the npm tarball contains the
worker, licenses and C helper sources, with no local checkout dependency or install hook.

The currently accepted worker has an ad hoc signature, not an Apple Developer ID
signature or notarization. Hash authentication is not Apple signing. Publishing it
as a controlled beta is the accepted initial scope; Developer ID signing and notarization
are deferred. Do not disable system security to make it run. Signing would change its bytes
and require a separately reviewed compiler baseline. A universal binary and Rosetta
tests do not establish Intel GPU support or a minimum-macOS qualification matrix.

The ordinary release/migration checklist in [CONTRIBUTING.md](../../CONTRIBUTING.md) still applies. An npm RC
must use `next`, not `latest`; staged npm publication is a separate future change.
