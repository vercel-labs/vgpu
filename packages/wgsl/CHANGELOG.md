# @vgpu/wgsl

## 0.4.0

### Minor Changes

- 8b2282c: Add the `vgpu/three` adapter for calling resolved WGSL function exports from three.js TSL, including a sound curried selector with positional export names, manually typed input contracts, identifier-minified shader support, a type-only `TslExportsErrorCode` union, and early rejection of global WGSL directives that Three cannot place correctly.

  Expose authored function-export metadata from the WGSL resolver and bundler loaders so integrations can address direct `export fn` declarations after mangling and minification. Add the `isShaderFunctionExport()` type guard to `@vgpu/wgsl`, with a convenience re-export from `vgpu`, for validating unknown metadata at integration boundaries.

  Treat WGSL comments as trivia around stage and resource-binding attributes so declaration DCE, emitted identifiers, and reflection metadata stay aligned.

  Use the entry source supplied by Vite and webpack during imported-graph resolution, preserving upstream transforms and virtual entries while resolving dependencies from their normal locations.

### Patch Changes

- @vgpu/wgsl-std@0.4.0

## 0.3.1

### Patch Changes

- e2b4c4a: Keep imported WGSL files registered with webpack/Turbopack and Vite when shader resolution fails, allowing a later valid save to rebuild failed importers without restarting the dev server.
  - @vgpu/wgsl-std@0.3.1

## 0.3.0

### Minor Changes

- 1451232: `EntryPointInfo` (`bindings`, `samplingPairs`, `inputs`) is now plain data: every field is an ordinary enumerable, own property. `JSON.stringify`, `{ ...entry }`, `Object.keys/entries/assign`, `structuredClone`, and worker `postMessage` all see the full shape — previously `bindings`, `samplingPairs` and `inputs` were non-enumerable, so they were readable through dot access but silently dropped across every serialization/structured-clone boundary (issue #252), including the `vgpu check` CLI JSON payload. The stopgap non-enumerable `toJSON()`/`EntryPointInfoJSON` this package briefly carried is removed in favor of making the underlying data itself lossless.

  Consumers that build bind group layouts (`vgpu`'s `set-layouts.ts`) still throw `VGPU-REFLECT-ENTRY-METADATA-MISSING` when an entry point arrives without `bindings`/`samplingPairs`/`inputs` metadata, rather than silently falling back to a wrong layout.

  BREAKING CHANGE (pre-1.0): code relying on `Object.keys(entryPoint)`, `{ ...entryPoint }`, or a JSON diff of an entry point _not_ containing `bindings`/`samplingPairs`/`inputs` will now see those keys. This is a clean break with no deprecated alias, consistent with this package's other 0.x breaking changes.

- 43dfa78: WGSL identifiers containing non-ASCII characters are now rejected at scan time with `VGPU-WGSL-IDENT-NONASCII` instead of being half-supported. **This is a deliberate behaviour change:** shaders that previously resolved (or silently miscompiled) now fail with one clear diagnostic that names the identifier, carries `line`/`column` and `range.file`, and links the tracking issue for real Unicode support — https://github.com/vercel-labs/vgpu/issues/294.

  The scanner read identifiers as `[A-Za-z_][A-Za-z0-9_]*` while WGSL identifiers are Unicode (XID_Start / XID_Continue), and every stage downstream — the token printer's separator predicates, the scope walker, the mangler, reflection — shared that assumption. Two failure families followed:

  - **Silent corruption.** A leading non-ASCII character fell through to the punctuation path, so the printer saw "identifier then punctuation" and dropped the separator: `let Ω = 1.0;` minified to `letΩ=1.0;`, a fused token no device accepts. Confirmed for every keyword that can precede a name (`let`, `var`, `const`, `return`), for parameters, and in `if`/`else`/`for`/`loop` positions, across Greek, Cyrillic and CJK names. With `minify: { whitespace: true }` this shipped as invalid WGSL that only failed later at `createShaderModule`.
  - **Bogus diagnostics.** In declaration positions the parser asked for an identifier and got punctuation: `fn åhelper(…)`, `struct åS { … }` and a struct member `åv: f32` reported `VGPU-WGSL-REFLECT-PARSE: Expected identifier`, and `const Ω: f32 = 1.0;` mangled the _type_ and blamed a missing bind group (`type '_vgsl_…__f32' is unknown … use a manual group claim`). A function containing one such name was also silently dropped from identifier minification by the scope walker's whole-function fallback.

  `café`-class names (ASCII start, non-ASCII continuation) are rejected too, even though their minified text round-tripped, because they are scanned as _fragments_ (`ident:caf` + `punct:é`) and the fragment — not the identifier — is what reaches reflection. Measured at every minify setting, `minify: false` included: `@compute fn maín()` reflected as entry point `"ma"`, `var<storage, read_write> sínk` reflected as binding `"s"`, and a struct member `café` reflected as `"caf"`. Those strings are the pipeline's `entryPoint` and the keys callers bind and write buffers by, so half-support corrupted a user-visible contract with no diagnostic at all. One rule — no non-ASCII in code position — is also what makes the guarantee explainable.

  Rejection lives in the scanner because that is the choke point every scanning path shares: it fires for the entry module and for imported modules (attributed to the module that declared the name), regardless of `minify` and `validate`, and therefore also protects the webpack/vite loaders, which resolve with validation off and never see device validation at all. One public path is **not** covered: `compile()` (the root `@vgpu/wgsl` entry for runtime WGSL strings) never runs the scanner, so a non-ASCII identifier passed to it is neither rejected nor minified, and its ASCII-only entry-point regex can still report such a name truncated or not at all — that gap is tracked with the rest of Unicode identifier support in https://github.com/vercel-labs/vgpu/issues/294.

  Nothing else about tokenization changes. Non-ASCII text stays legal in line and block **comments** (accented prose, emoji and CJK in shipped shaders keep working, byte-for-byte in every minify mode), in string literals and import paths (`import { helper } from "./señal.wgsl";`), and a leading byte-order mark is still skipped as blankspace. Only characters that would otherwise become part of a code token are rejected.

- 1255833: `resolveShader`'s `validate` option is now honest. Previously `validate` defaulted to `true` but the device-backed check silently no-op'd outside this project's own Docker CI harness (`validateWGSL` returned immediately unless `VGPU_DOCKER_TEST=1`) — every other environment paid nothing and got nothing, while the option and its docs claimed WGSL was being validated.

  `validate` is now a tri-state `"off" | "auto" | "require"` (booleans still work: `true` -> `"require"`, `false` -> `"off"`). The default is `"auto"`: it _attempts_ device-backed validation everywhere now, throws `VGPU-WGSL-NAGA-UNKNOWN` on real WGSL errors as before, and — only when no WebGPU device/adapter is available — warns once to stderr with an actionable fix and records the skip on the new `ResolvedShader.validation` field (`{ mode, attempted, ok, skipped? }`) instead of pretending nothing happened. `"require"` throws `VGPU-WGSL-VALIDATE-NO-DEVICE` / `VGPU-WGSL-VALIDATE-ADAPTER-MISSING` (forwarding `@vgpu/adapter-node`'s own `fix` text verbatim, plus `cause` and `metadata.causeCode`) instead of skipping. A new `VGPU_VALIDATE` env var (`off`/`auto`/`require`, anything else throws `VGPU-WGSL-VALIDATE-ENV-INVALID`) sets the process-wide default; an explicit `validate` option always wins over it.

  What this means in practice: code that already passed `validate: false` (including the vite/webpack loaders) is unchanged and still never touches device code. Code that relied on the default now really validates when a device is present, so genuinely invalid WGSL that used to slip through will start failing — that is the point of the change. Machines without a device see one stderr warning per process instead of silent success.

  `@vgpu/adapter-node` is now an _optional_ peer dependency of `@vgpu/wgsl`, imported lazily (and only when validation actually runs) so there is no static dependency, no bundle cost, and no build cycle. Consumers without it installed hit `VGPU-WGSL-VALIDATE-ADAPTER-MISSING`: a warning in `"auto"`, an error in `"require"`.

  Validation shares one WebGPU device per process and destroys it shortly after the last validation, so scripts that call `resolveShader` still exit on their own (a live Dawn device otherwise keeps the Node event loop alive indefinitely).

  Concurrent `resolveShader` calls no longer mis-attribute diagnostics. WebGPU error scopes are a stack on the device, and every validation shares the one memoized device, so interleaved push/pop pairs could pop each other's scopes — a valid shader could be rejected with a neighbour's diagnostic, or an invalid one pass because a neighbour popped its error. The scope-bracketed section is now serialized per device. Previously unreachable (validation only ran inside this repo's Docker harness, sequentially); reachable now that validation is on by default.

  `vgpu check` gains `--require-validation` (fail instead of degrading when no device is available), includes the new `validation` object in its JSON payload, and now forwards `fix`/`where` on error payloads and diagnostics — both were silently dropped before, so remediation text never reached anyone reading the CLI's JSON.

  `check`'s JSON contract no longer depends on whether the machine running it has a WebGPU device. When validation rejects the shader (or `--require-validation` cannot get a device), `check` still prints the whole payload — `diagnostics`, `reflection`, `wgsl` — and reports the failure as `validation.error` with `ok: false`, exiting 1; previously a validation failure replaced the entire document with a single error object on stderr, which on a device-having machine would have hidden the reflection diagnostics (including their fix-it text) that the same command printed on a device-less one. Resolution failures are unchanged: still a single error object on stderr with no payload.

### Patch Changes

- b86fe6e: Fix the lazy `@vgpu/adapter-node` import in the validation device loader so bundlers can see it's an
  ordinary package specifier: it now uses a literal specifier (typed via a local ambient module
  declaration) instead of a variable, so `tsc` no longer wraps it in its
  `__rewriteRelativeImportExtension` helper. That wrapper was invisible to both webpack's module
  parser and Next.js's build-dependency cache scanner, so every consumer that bundles the loader saw
  two spurious warnings per build ("Critical dependency: the request of a dependency is an
  expression" during the webpack ESM build-dependency scan, plus "Build dependencies behind this
  expression are ignored and might cause incorrect cache invalidation"). The dynamic import still
  only runs in Node and behaves identically at runtime.
  - @vgpu/wgsl-std@0.3.0
- 6ea8edf: Document that `@vgpu/wgsl/runtime` is ESM-only in the `resolveShader` reference. The `./runtime` subpath declares only an `import` condition, so calling it from a CommonJS entry point fails with Node's `ERR_PACKAGE_PATH_NOT_EXPORTED` rather than a `VGPU-*` code — name the script `.mjs`/`.mts` or set `"type": "module"`.
- 42bffb4: `resolveShader` no longer deletes a module-scope declaration when an unrelated function-scope local reuses its name. Import mangling tracked shadowing in a flat `Set<string>` of every local name seen so far, and that set was never scoped and never cleared: the first `let helper` in a nested block — or a parameter named `helper` on a completely different function, or a `for` loop variable — permanently stopped _every later_ `helper` token in the module from being rewritten. The declaration itself, emitted before the shadow, was still rewritten to `_vgsl_<hash>__helper`, so the real call site kept the bare name, declaration DCE correctly saw the mangled declaration as unreferenced and dropped it, and the shader failed to compile with `unresolved call target 'helper'`. Shadowing is now resolved lexically per token, so a local only hides a module symbol inside the block that introduced it.

  This corrupted valid WGSL at every minify setting, `minify: false` included — it is an emission bug, not a minification bug. All five confirmed shapes are fixed: a nested-block `let` shadowing a module `fn`, a `struct` later used as a type (`unresolved type 'S'`), or a module `const` (`unresolved value 'K'`); a parameter of an unrelated function; and a `for` loop variable. The cross-module form — an imported helper shadowed by a local in the entry module — is fixed with them. An organic 400-shader fuzz corpus that previously tripped this on 1% of cases now comes back clean.

  Scoping follows WGSL's own rules, so the fix does not keep more than it should. A local enters scope at the end of its own declaration statement, which means the initializer in `let helper = helper(1.0);` still calls the module-scope `helper`, and a reference _before_ the shadowing declaration in the same block still binds to the module symbol. A `for` frame spans header plus body so a loop variable does not leak past its loop. A formal parameter is in scope in the function body only, so a parameter named `helper` does not stop a sibling parameter's type, its template arguments (`ptr<function, helper>`) or the `-> helper` return type from resolving to the module-scope `helper`. Declarations that are genuinely dead are still removed, including one whose name is also shadowed somewhere, and the shadowing local itself is never rewritten to the module symbol it collides with.

- 1e27582: Minification no longer corrupts leading-dot float literals. WGSL's `decimal_float_literal` may start with a dot (`.5`, `.0`, `.5e2`, `.5f`), but the scanner only opened a number token on a leading digit, so `.5` was tokenized as punctuation `.` plus the number `5`; the token printer's dot/digit separator rule then wrote `. 5`, which no device accepts (`unable to parse right side of assignment`). `.5` is now scanned as one number token, so `out_buf[0] = .5;` minifies to `out_buf[0]=.5;` instead of `out_buf[0]=. 5;`.

  This was reachable from every entry point that minifies: `minify: true` threw the naga diagnostic (after #273, whitespace-only minification does too, instead of silently returning broken WGSL), and two shaders shipped in this repository — `apps/docs/examples/fluid/divergence.wgsl` and `project.wgsl`, both containing `…*.5*f32(grid.size.x)…` — could not be built with `minify: true` at all. Affected forms included `.5`, `.0`, `.5e2`, `.5f`, `-.5`, `(.5)`, `max(.5,1.0)`, `array<f32,2>(.5,1.0)`, `x*.25`, and the same literals inside imported modules.

  Nothing else about tokenization changes. A `.` is only absorbed into a number when the very next character is a digit, and neither member names nor swizzles can start with a digit, so member access and swizzles (`v.x`, `a.xyz`, `s.inner.value`, `vec2f(1.0,2.0).x`) are untouched; trailing-dot and exponent forms (`1.`, `1.e3`, `1e3`, `0x1p1`, `0x1.8p1`) still go through the leading-digit path and minify byte-identically to before. A dot that is _not_ adjacent to its digits in the source (`. 5`) is still printed with its separator rather than being fused into a literal the author did not write.

- 836116e: Fix `minify: true` (`identifiers: "safe"`) dropping or misattributing references to local `let`/`var`/`const` declarations whose initializer contains a comparison or shift operator (`<`, `>`, `<=`, `>=`, `<<`, `>>`) — e.g. `let flag = uv.x < 1.0;`. The scope walker's statement-end scanner mistracked these operators as template-argument brackets, delaying the declaration's scope activation past its own later references. Depending on shape this either left a dangling identifier in the minified output (fails at `createShaderModule`) or — when the local shadowed an outer same-named declaration — silently renamed the reference to the outer variable (valid WGSL, wrong result, no diagnostic). `minify`'s identifier renamer now also independently verifies every renamed local has no leftover unrenamed reference before emitting, downgrading any future recurrence to a missed optimization instead of corrupt output; the `ResolveOptions.validate` doc now says plainly that its GPU-backed check is a no-op outside the Docker test harness, and that this self-check runs regardless of `validate`.
- d1b73c8: `@vgpu/wgsl/runtime` is now reachable from CommonJS. The subpath declared only `types` and `import` conditions, so any consumer that resolved it through `require` — a plain `require("@vgpu/wgsl/runtime")`, a `.cts` file, or a `tsx`/ts-node script in a project without `"type": "module"` — failed with `ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './runtime' is not defined by "exports"`, even though the sibling subpaths (`./loader-webpack`, `./loader-vite`, `./reflect-source`) all already exposed `require`/`default`. `./runtime` now mirrors them and points every condition at the same ESM file, which Node 22 loads through `require(esm)`: the runtime entry has no top-level await and its only ESM-specific constructs are `createRequire(import.meta.url)` calls, both of which are fine under synchronous `require(esm)`.
- 9812605: `resolveShader()` now validates the WGSL it actually returns, whatever the minify mode. Previously the post-minify validation pass ran only for `minify: true` / `minify: { identifiers: "safe" }`; whitespace-only minification (`minify: { whitespace: true }`, which is what the object form defaults to) was never re-validated, so a whitespace-stage minifier bug returned `validation: { attempted: true, ok: true }` together with WGSL that fails `createShaderModule` in the consumer's app. The `VGPU-WGSL-MINIFY-DANGLING-IDENT` self-check could not cover this: it is scoped to identifier renaming.

  The guarantee now: with `validate` other than `"off"`, if `resolveShader()` resolves with `validation.ok === true`, the exact `wgsl` string it hands back was accepted by the device. Corrupt minifier output throws `VGPU-WGSL-NAGA-UNKNOWN` at resolve time instead of surfacing as a shader-module failure later.

  Observable change: a whitespace-only minified shader whose minified text the device rejects now **throws** where it previously resolved. That is the fix — the previous success was a false one — but it can turn a silently-broken build into a failing one. `validate: "off"` (or `VGPU_VALIDATE=off`) is unaffected and still never touches a device; both bundler loaders already pass `validate: false`, so webpack/vite/turbopack builds are unchanged.

  Validation still runs first on the unminified emission, because that text is what yields accurate line/column diagnostics against your source modules; the second pass on the final text reuses the same leased device and is skipped entirely when minification changed nothing, so a non-minifying resolve still validates exactly once.

  - @vgpu/wgsl-std@0.3.0

## 0.2.0

### Minor Changes

- 3731a3c: WGSL package imports now resolve third-party and workspace packages in every install layout. A package that exports `.wgsl` files through its `exports` map (the same shape `@vgpu/wgsl-std` uses) already worked when installed as a direct dependency under npm and pnpm, including a `workspace:*` package linked into an app in a monorepo, but two layouts failed with `VGPU-WGSL-PKG-NOTFOUND`:

  - **A WGSL package that imports another WGSL package under pnpm.** The importing module lives in `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>`, reached through a symlink, and its own dependencies are installed next to that store entry — never next to the symlink, so the `node_modules` walk could not see them. The walk now also runs from the importing file's real path, which is how Node itself resolves.
  - **Yarn PnP.** PnP keeps packages inside zip archives with no `node_modules` directories to walk. When the PnP runtime is active in the process (any `yarn`-launched build), the resolver now asks Node to resolve the specifier _from the importing shader_, which hits Yarn's resolver and returns a zip-internal path that PnP's patched `fs` can read.

  Resolution precedence is unchanged: the importing project's own `node_modules` still wins, the walk still stops at the workspace root, and the `@vgpu/*`-scoped fallback that rescues `@vgpu/wgsl-std` from an isolated layout still runs last. The new PnP step resolves from the _user's_ file, so it can only reach what the shader's own package declares.

- eba8e4d: `VGPU-WGSL-PKG-NOTFOUND` now prescribes the fix instead of only naming the miss: an uninstalled package reports `Package <pkg> was not found. Install the package (npm install <pkg>) or check the specifier`, in-memory resolution points at `packageMap`/`modules`, and an unknown subpath names the package and its `exports` map. Scoped packages are also reported correctly — the filesystem message said `Package @vgpu` for `@vgpu/wgsl-std/noise` before.

  WGSL package imports also resolve in layouts where the package reaches the project transitively. Resolution now tries the importing project's `node_modules` first (an installed copy always wins) and then Node's own resolver next to `@vgpu/wgsl`, which depends on `@vgpu/wgsl-std`. Walking up from the shader alone only worked when the package manager hoisted the package, so `import ... from "@vgpu/wgsl-std/noise"` failed under pnpm's isolated `node_modules` and Yarn PnP even though the package was installed.

- 47f7ec8: Add `constants` to `DrawOptions` (`draw(gpu)`) and `ComputeOptions` (`compute(gpu)`): constructor-only values for WGSL `override` pipeline constants, flowing into `GPUProgrammableStage.constants` — both the vertex and fragment stages for draws (WebGPU matches keys against the module's override declarations, not per entry point, so one record serves both stages) and the compute stage for compute pipelines. Key by override name, or by the decimal string of `N` when the declaration has `@id(N)` (the name is not usable then, mirroring WebGPU's identifier rule). Values are finite numbers or booleans; booleans convert to `1`/`0` doubles that WebGPU converts to the override's WGSL type (bool/i32/u32/f32/f16). Draws that differ only in `constants` compile distinct pipelines; an absent option — or an empty `{}` — keeps byte-identical descriptors and pipeline cache keys. `VGPU-CONSTANTS-INVALID` throws at construction for a non-object `constants`, a key that matches no override in the shader (the message lists the available overrides), a value that is neither a finite number nor a boolean, or an override declared without a default that `constants` does not provide.

  `@vgpu/wgsl` reflection: `OverrideInfo` gains an optional `id` field carrying the `@id(N)` pipeline constant ID; `defaultValue` continues to mark declarations with a default initializer. The change is additive — existing `Reflection` consumers are unaffected.

### Patch Changes

- 2856407: The transitive-resolution fallback in `resolveImport` is now scoped to `@vgpu/*` specifiers. That fallback (`resolveAlongsideResolver`) exists only to rescue `@vgpu/wgsl`'s own transitive dependencies (like `@vgpu/wgsl-std`) in isolated pnpm/PnP layouts, but it previously ran for any bare specifier that failed the project-local `node_modules` walk. That meant a mistyped or unrelated WGSL import (e.g. `webpack`, a devDependency of `@vgpu/wgsl` itself) could resolve to the real installed JS file and fail later with a confusing `VGPU-WGSL-REFLECT-PARSE Expected identifier`, instead of the clear `VGPU-WGSL-PKG-NOTFOUND` (with its install fix-it) that non-`@vgpu` specifiers should get.
- Updated dependencies [8345a03]
- Updated dependencies [65cc995]

  - @vgpu/wgsl-std@0.2.0

- f526de2: Resolve bare package specifiers in WGSL _nominal type_ positions. A struct imported from a package subpath — `import { VoronoiSample2 } from "@vgpu/wgsl-std/noise"` — can now type a binding, a struct member, a type alias or a function signature; previously only relative and root-alias imports resolved there, so reflection silently failed to find the struct and the binding came back without its `struct`/`layout` (member names, offsets and sizes). The value/function positions handled by the mangler were already correct, which is why the gap only showed up in reflected layouts.

  `buildModuleSymbols()` now takes the same import resolver that loaded the module graph, so nominal types go through the identical resolution the loader used (relative, root alias, `packageMap`, `package.json` `exports`). `resolveShader()` passes its resolver through; when no resolver is available, or resolution throws, the previous relative/absolute heuristic still applies, so nothing that resolved before stops resolving.

- 8fc4daf: Report WGSL reserved words and keywords used as declared identifiers on every build-time path. Struct names, struct members, type aliases, module-scope variables, overrides, functions, parameters and local variables whose name is reserved by the WGSL spec (e.g. `struct Paint { from: vec2f }`) now produce a `VGPU-WGSL-RESERVED-IDENT` error diagnostic with the offending name, file, line and column. Previously these passed with zero diagnostics and only failed later inside Dawn at pipeline creation.

  - `resolveShader()` collects the diagnostics per loaded module, so imported modules report their own location.
  - The Vite plugin and the webpack loader fail the build on error-severity diagnostics — in both the leaf-shader path and the import-graph path — with a message listing `file:line:column`. Warnings such as `VGPU-WGSL-PKG-CONDITIONAL` stay non-fatal.
  - `vgpu check` serializes diagnostics correctly (their `message` was being dropped by `JSON.stringify` because `Error.message` is not enumerable) and exits with code `1` when any error-severity diagnostic is reported.

  `compile()` keeps its byte-for-byte passthrough behavior: running the pass there would pull the scanner into the browser-facing `@vgpu/wgsl` entry (688 B → 4062 B gzip against a 1024 B budget), and runtime WGSL strings are reported by the driver at `createShaderModule`.

  The reserved-word and keyword lists are now verbatim from the WGSL spec: this adds `non_coherent`, `noncoherent` and `type`, and moves `binding_array` (dropped from the current spec list) into a separate legacy set that still blocks identifier minification from generating it.
