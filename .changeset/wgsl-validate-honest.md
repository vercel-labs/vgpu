---
"@vgpu/wgsl": minor
"@vgpu/cli": minor
---

`resolveShader`'s `validate` option is now honest. Previously `validate` defaulted to `true` but the device-backed check silently no-op'd outside this project's own Docker CI harness (`validateWGSL` returned immediately unless `VGPU_DOCKER_TEST=1`) — every other environment paid nothing and got nothing, while the option and its docs claimed WGSL was being validated.

`validate` is now a tri-state `"off" | "auto" | "require"` (booleans still work: `true` -> `"require"`, `false` -> `"off"`). The default is `"auto"`: it *attempts* device-backed validation everywhere now, throws `VGPU-WGSL-NAGA-UNKNOWN` on real WGSL errors as before, and — only when no WebGPU device/adapter is available — warns once to stderr with an actionable fix and records the skip on the new `ResolvedShader.validation` field (`{ mode, attempted, ok, skipped? }`) instead of pretending nothing happened. `"require"` throws `VGPU-WGSL-VALIDATE-NO-DEVICE` / `VGPU-WGSL-VALIDATE-ADAPTER-MISSING` (forwarding `@vgpu/adapter-node`'s own `fix` text verbatim, plus `cause` and `metadata.causeCode`) instead of skipping. A new `VGPU_VALIDATE` env var (`off`/`auto`/`require`, anything else throws `VGPU-WGSL-VALIDATE-ENV-INVALID`) sets the process-wide default; an explicit `validate` option always wins over it.

What this means in practice: code that already passed `validate: false` (including the vite/webpack loaders) is unchanged and still never touches device code. Code that relied on the default now really validates when a device is present, so genuinely invalid WGSL that used to slip through will start failing — that is the point of the change. Machines without a device see one stderr warning per process instead of silent success.

`@vgpu/adapter-node` is now an *optional* peer dependency of `@vgpu/wgsl`, imported lazily (and only when validation actually runs) so there is no static dependency, no bundle cost, and no build cycle. Consumers without it installed hit `VGPU-WGSL-VALIDATE-ADAPTER-MISSING`: a warning in `"auto"`, an error in `"require"`.

Validation shares one WebGPU device per process and destroys it shortly after the last validation, so scripts that call `resolveShader` still exit on their own (a live Dawn device otherwise keeps the Node event loop alive indefinitely).

Concurrent `resolveShader` calls no longer mis-attribute diagnostics. WebGPU error scopes are a stack on the device, and every validation shares the one memoized device, so interleaved push/pop pairs could pop each other's scopes — a valid shader could be rejected with a neighbour's diagnostic, or an invalid one pass because a neighbour popped its error. The scope-bracketed section is now serialized per device. Previously unreachable (validation only ran inside this repo's Docker harness, sequentially); reachable now that validation is on by default.

`vgpu check` gains `--require-validation` (fail instead of degrading when no device is available), includes the new `validation` object in its JSON payload, and now forwards `fix`/`where` on error payloads and diagnostics — both were silently dropped before, so remediation text never reached anyone reading the CLI's JSON.

`check`'s JSON contract no longer depends on whether the machine running it has a WebGPU device. When validation rejects the shader (or `--require-validation` cannot get a device), `check` still prints the whole payload — `diagnostics`, `reflection`, `wgsl` — and reports the failure as `validation.error` with `ok: false`, exiting 1; previously a validation failure replaced the entire document with a single error object on stderr, which on a device-having machine would have hidden the reflection diagnostics (including their fix-it text) that the same command printed on a device-less one. Resolution failures are unchanged: still a single error object on stderr with no payload.
