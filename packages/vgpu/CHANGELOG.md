# @vgpu/cli

## 0.2.3-rc.0

### Patch Changes

- 5c18170: Bundle versioned consumer migration guides in the local docs CLI and MCP corpus. Discover them with `vgpu docs ls /migrations` and read a guide with `vgpu docs cat /migrations/0.5.0.docs.md`. Collect migration instructions from changesets during release preparation instead of relying on standalone repository files.

## 0.2.2

### Patch Changes

- 01470c5: Make the repository skill a version-neutral router that reads documentation from the project's selected `vgpu` package, keeping agent guidance aligned with the installed stable or prerelease version.

## 0.2.1

### Patch Changes

- 0b9b564: Expose the existing documentation and verified examples workflows as two MCP tools. Add a local
  `vgpu mcp` stdio server with opt-in, output-directory-confined example downloads and publish a
  read-only Streamable HTTP endpoint at `https://vgpu.sh/api/mcp` using the stateless modern MCP
  transport.
- f4b4b27: Make online `vgpu examples` commands work on macOS and Windows. `search`, `show`, and `cat` now
  use an in-memory cache when Linux's descriptor-anchored persistent cache is unavailable. On macOS,
  `pull` uses a portable symlink-checked staging path and preserves atomic publication and recovery.
  Linux keeps its persistent offline cache and `/proc/self/fd` hardening unchanged.

## 0.2.0

### Minor Changes

- 57389a4: `vgpu examples`'s discovery handshake now evaluates `schemaSha256` -> `status` (revoked/deprecated) -> `minimumCliVersion` -> the trusted-origin check on `indexUrl`, instead of running the origin check second. Previously, a CLI whose only problem was being out of date against a migrated origin surfaced `VGPU-EXAMPLES-INTEGRITY` ("API URL leaves trusted origin") instead of the more accurate `VGPU-EXAMPLES-CLI-TOO-OLD`, because the trusted-origin assertion ran before the version comparison (issue #255). Revocation (`status: "revoked"`) and the deprecation warning still take precedence over the version gate, unchanged from before -- this is a narrower reorder than the issue's literal proposal, which would also have let an old CLI see a revoked contract's status masked by `CLI-TOO-OLD`.

  The primary observable change: an old CLI querying a discovery document whose contract `indexUrl` points at an origin the CLI does not yet trust (e.g. after a `vgpu.sh` origin migration), where the server has also raised `minimumCliVersion` past that CLI's version:

  | Scenario (contract `indexUrl` is off-origin for this CLI) | Before                    | After                                                     |
  | --------------------------------------------------------- | ------------------------- | --------------------------------------------------------- |
  | CLI older than `minimumCliVersion`                        | `VGPU-EXAMPLES-INTEGRITY` | `VGPU-EXAMPLES-CLI-TOO-OLD`                               |
  | `status: "revoked"`                                       | `VGPU-EXAMPLES-INTEGRITY` | `VGPU-EXAMPLES-INCOMPATIBLE-API`                          |
  | `status: "deprecated"`                                    | `INTEGRITY`, no warning   | `INTEGRITY` (unchanged) + deprecation warning now emitted |

  Exit code stays 5 in every row. Two notes on the rows beyond the first. The `revoked` row matters if you key on `INTEGRITY` during a migration whose contract is also revoked: you now get the more accurate `INCOMPATIBLE-API`, because the kill switch is evaluated before the origin check rather than after it. The `deprecated` row only adds a static warning string (`"Warning: vgpu-examples/v1 is deprecated.\n"`) that `handshake()` now reaches before failing the trust check; the error code and exit code are unchanged, and `vgpu examples` itself still prints accumulated warnings only on success paths, so CLI output in that case is unaffected.

  Same-origin `indexUrl` (the normal case) is unaffected in all of the above: `revoked` already reported `INCOMPATIBLE-API` and `deprecated` already warned.

  No wire format change: same `contracts[]` fields, same `discoveryVersion: 1`, same `schemaSha256` value. Servers cannot observe a CLI's internal check order. Do **not** bump `schemaSha256` to "trigger" this fix -- the schema check still runs first and is a hardcoded-constant comparison, not a signature; changing it breaks every deployed CLI with `VGPU-EXAMPLES-INCOMPATIBLE-API`.

  BREAKING CHANGE (pre-1.0): anything that keys on `error.code === 'VGPU-EXAMPLES-INTEGRITY'` to detect version skew against a migrated origin will now see `VGPU-EXAMPLES-CLI-TOO-OLD` instead. This is the intended fix -- `INTEGRITY` is reserved for tampering/corruption signals, and conflating "your CLI is old" with "this data may be tampered with" was the bug. CLIs already published at or before `0.2.0-rc.0` are unaffected: they embed the old check order and keep emitting `INTEGRITY` regardless of this change. For this fix to help the _next_ origin migration, operators must raise `minimumCliVersion` in the served discovery contract as part of that migration -- see `apps/docs/examples-api.md`.

- 1451232: `EntryPointInfo` (`bindings`, `samplingPairs`, `inputs`) is now plain data: every field is an ordinary enumerable, own property. `JSON.stringify`, `{ ...entry }`, `Object.keys/entries/assign`, `structuredClone`, and worker `postMessage` all see the full shape — previously `bindings`, `samplingPairs` and `inputs` were non-enumerable, so they were readable through dot access but silently dropped across every serialization/structured-clone boundary (issue #252), including the `vgpu check` CLI JSON payload. The stopgap non-enumerable `toJSON()`/`EntryPointInfoJSON` this package briefly carried is removed in favor of making the underlying data itself lossless.

  Consumers that build bind group layouts (`vgpu`'s `set-layouts.ts`) still throw `VGPU-REFLECT-ENTRY-METADATA-MISSING` when an entry point arrives without `bindings`/`samplingPairs`/`inputs` metadata, rather than silently falling back to a wrong layout.

  BREAKING CHANGE (pre-1.0): code relying on `Object.keys(entryPoint)`, `{ ...entryPoint }`, or a JSON diff of an entry point _not_ containing `bindings`/`samplingPairs`/`inputs` will now see those keys. This is a clean break with no deprecated alias, consistent with this package's other 0.x breaking changes.

- 1255833: `resolveShader`'s `validate` option is now honest. Previously `validate` defaulted to `true` but the device-backed check silently no-op'd outside this project's own Docker CI harness (`validateWGSL` returned immediately unless `VGPU_DOCKER_TEST=1`) — every other environment paid nothing and got nothing, while the option and its docs claimed WGSL was being validated.

  `validate` is now a tri-state `"off" | "auto" | "require"` (booleans still work: `true` -> `"require"`, `false` -> `"off"`). The default is `"auto"`: it _attempts_ device-backed validation everywhere now, throws `VGPU-WGSL-NAGA-UNKNOWN` on real WGSL errors as before, and — only when no WebGPU device/adapter is available — warns once to stderr with an actionable fix and records the skip on the new `ResolvedShader.validation` field (`{ mode, attempted, ok, skipped? }`) instead of pretending nothing happened. `"require"` throws `VGPU-WGSL-VALIDATE-NO-DEVICE` / `VGPU-WGSL-VALIDATE-ADAPTER-MISSING` (forwarding `@vgpu/adapter-node`'s own `fix` text verbatim, plus `cause` and `metadata.causeCode`) instead of skipping. A new `VGPU_VALIDATE` env var (`off`/`auto`/`require`, anything else throws `VGPU-WGSL-VALIDATE-ENV-INVALID`) sets the process-wide default; an explicit `validate` option always wins over it.

  What this means in practice: code that already passed `validate: false` (including the vite/webpack loaders) is unchanged and still never touches device code. Code that relied on the default now really validates when a device is present, so genuinely invalid WGSL that used to slip through will start failing — that is the point of the change. Machines without a device see one stderr warning per process instead of silent success.

  `@vgpu/adapter-node` is now an _optional_ peer dependency of `@vgpu/wgsl`, imported lazily (and only when validation actually runs) so there is no static dependency, no bundle cost, and no build cycle. Consumers without it installed hit `VGPU-WGSL-VALIDATE-ADAPTER-MISSING`: a warning in `"auto"`, an error in `"require"`.

  Validation shares one WebGPU device per process and destroys it shortly after the last validation, so scripts that call `resolveShader` still exit on their own (a live Dawn device otherwise keeps the Node event loop alive indefinitely).

  Concurrent `resolveShader` calls no longer mis-attribute diagnostics. WebGPU error scopes are a stack on the device, and every validation shares the one memoized device, so interleaved push/pop pairs could pop each other's scopes — a valid shader could be rejected with a neighbour's diagnostic, or an invalid one pass because a neighbour popped its error. The scope-bracketed section is now serialized per device. Previously unreachable (validation only ran inside this repo's Docker harness, sequentially); reachable now that validation is on by default.

  `vgpu check` gains `--require-validation` (fail instead of degrading when no device is available), includes the new `validation` object in its JSON payload, and now forwards `fix`/`where` on error payloads and diagnostics — both were silently dropped before, so remediation text never reached anyone reading the CLI's JSON.

  `check`'s JSON contract no longer depends on whether the machine running it has a WebGPU device. When validation rejects the shader (or `--require-validation` cannot get a device), `check` still prints the whole payload — `diagnostics`, `reflection`, `wgsl` — and reports the failure as `validation.error` with `ok: false`, exiting 1; previously a validation failure replaced the entire document with a single error object on stderr, which on a device-having machine would have hidden the reflection diagnostics (including their fix-it text) that the same command printed on a device-less one. Resolution failures are unchanged: still a single error object on stderr with no payload.

### Patch Changes

- 43a2480: `vgpu docs find` route hits are now ranked instead of returned alphabetically. `docs find gpu` used to dump 134 unranked lines (since "gpu" substring-matches nearly the whole index) and bury the exact match `Gpu` / `/vgpu/gpu.docs.md` around line 100; `find a` returned 260 lines with no way to tell a complete result set from a truncated one.

  Route hits are now sorted into six match-quality tiers (exact symbol, exact page identity, word-boundary in name text, word-boundary in path, substring in name text, substring in path only), tie-broken by the shared package curation ladder, then page hits before symbol hits, then a stable line compare. Both the route and content tiers now share one `HIT_LIMIT` of 20 (replacing the separate `CONTENT_HIT_LIMIT`), and stdout appends a truncation notice whenever a tier is capped, so it's clear when results were cut off.

- 6ea8edf: Add the "Using vgpu without a bundler" and "Two-pass rendering" guides, link both from getting-started, and route the dogfood queries to them. Shaders in their own `.wgsl` file with no bundler now have one page (`resolveShader()` + `vgpu/node` + the ESM-only gotcha) instead of being findable only by symbol name, and the offscreen-depth-target-composited-to-the-canvas recipe — previously split across Draws, Passes and Frames — is one copy-pasteable page. `docs find "two-pass"` used to print "No docs found"; `"no bundler"`, `".wgsl file"`, `"offscreen depth"`, `"composite scene to canvas"` and `"render to texture"` now land on the guide that answers them.
- 12b4efa: Label the CPU software renderer fallback so the native Vulkan/XDG_RUNTIME_DIR startup lines stop reading as fatal errors. The Node adapter now prints one `vgpu: notice — …` block on stderr (once per process, after the adapter is known, so it lands below the native lines it explains) that names the selected CPU renderer, states that rendering continues normally, and says the Dawn/Vulkan loader/Mesa `error`/`Warning` lines above come from the driver stack and are harmless. The notice also covers runs where Dawn selects a CPU adapter directly, not just the consented portable-renderer retry; explicit `adapter: "software"` stays silent.

## 0.1.8

### Patch Changes

- 639247f: `vgpu docs find` now answers multi-word and prose queries. Every whitespace-separated word must match, matching covers page titles and the `keywords` a page declares in its frontmatter, and when none of that hits it falls back to searching page bodies — so `find "wgsl loader"`, `find "typescript wgsl import"`, and `find VGPU-WGSL-PKG-NOTFOUND` resolve to a page instead of printing `No docs found`.

## 0.1.7

### Patch Changes

- 8fc4daf: Report WGSL reserved words and keywords used as declared identifiers on every build-time path. Struct names, struct members, type aliases, module-scope variables, overrides, functions, parameters and local variables whose name is reserved by the WGSL spec (e.g. `struct Paint { from: vec2f }`) now produce a `VGPU-WGSL-RESERVED-IDENT` error diagnostic with the offending name, file, line and column. Previously these passed with zero diagnostics and only failed later inside Dawn at pipeline creation.

  - `resolveShader()` collects the diagnostics per loaded module, so imported modules report their own location.
  - The Vite plugin and the webpack loader fail the build on error-severity diagnostics — in both the leaf-shader path and the import-graph path — with a message listing `file:line:column`. Warnings such as `VGPU-WGSL-PKG-CONDITIONAL` stay non-fatal.
  - `vgpu check` serializes diagnostics correctly (their `message` was being dropped by `JSON.stringify` because `Error.message` is not enumerable) and exits with code `1` when any error-severity diagnostic is reported.

  `compile()` keeps its byte-for-byte passthrough behavior: running the pass there would pull the scanner into the browser-facing `@vgpu/wgsl` entry (688 B → 4062 B gzip against a 1024 B budget), and runtime WGSL strings are reported by the driver at `createShaderModule`.

  The reserved-word and keyword lists are now verbatim from the WGSL spec: this adds `non_coherent`, `noncoherent` and `type`, and moves `binding_array` (dropped from the current spec list) into a separate legacy set that still blocks identifier minification from generating it.
