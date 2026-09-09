# Dependency security maintenance

Reviewed on 2026-09-09 for PR #427. Package overrides and their compatibility
rationale live in the root `package.json`; do not remove a security floor just
to satisfy an older transitive range.

## image-size 2.0.2

The pinned Fumadocs stack uses `image-size` for image dimensions. Upstream has
no published fix for [ICNS denial of service](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr)
or [JXL/HEIF denial of service](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq).
The explicit pnpm patch rejects non-advancing or undersized entries and invalid
container bounds across the package's CommonJS and ESM distributions. It keeps
the existing buffer, file and format APIs.

`scripts/image-size-security.test.ts` exercises the dependency resolved by
Fumadocs, including valid inputs and hostile buffers. Each parse runs in a
memory-limited child process with an external deadline: a parser hang or crash
is a test failure, not a successful rejection. The suite runs in both root
`test` and `test:fast`.

This is a local mitigation, **not an upstream patched release**. Version-based
audits still report the two high-severity advisories for 2.0.2. No audit ignore,
Dependabot dismissal, test skip or security-check bypass is added. Remove the
patch only when the whole Fumadocs/Geistdocs tree moves to a maintained parser
and these regressions pass against it. A blind alias to `@fumari/image-size`
is not compatible with the existing `image-size/fromFile` import.

## Eve vendored dependencies

Eve 0.29.5 embeds fast-uri 3.1.2 and js-yaml 4.1.1 under its own distribution;
root overrides and the lockfile audit do not replace those copies. The reviewed
factory paths use native URL validation and trusted, package-owned YAML grading
templates, not untrusted data in these affected parser APIs. No exploitable
authored path was identified, but the embedded implementations are not certified
safe. Reassess before adding remote YAML, dynamic schemas or new tools.

Its embedded Undici chunk also lacks a reliably identified version. The reviewed
local Workflow consumer uses a normal Agent, not the affected retry/cookie/cache
APIs. This remains a supply-chain visibility limitation outside `pnpm audit`.

Eve 0.52.4 still embeds the affected parser implementations and changes the
client/session API, so an incidental framework upgrade is not a fix. Keep the
current version pinned; obtain refreshed upstream bundles/SBOM information and
revalidate auth, cancellation, isolation and tool discovery in a dedicated
framework migration. No upstream issue or alert dismissal was performed here.
