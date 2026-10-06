---
title: "prepareShader"
description: "Turns one import-free WGSL string into the prepared `ShaderSource` artifact that `draw`, `effect`, and `compute` consume. Use it for WGSL you build or receive at runtime, for resolver output, and to upgrade legacy v1 assets; for static `.wgsl` files, the Vite/webpack loaders already call it at build time."
---

## Import

```ts
import { prepareShader } from "@vgpu/wgsl/prepare";
```

`@vgpu/wgsl/prepare` is the only entrypoint that exports `prepareShader`. It is not re-exported from `vgpu`, `vgpu/node`, `vgpu/mock`, or the `@vgpu/wgsl` root. `@vgpu/wgsl` is a dependency of `vgpu`; when your package manager does not expose transitive dependencies to your code (pnpm's default isolated layout does not), add `@vgpu/wgsl` to your own `package.json` at the version your `vgpu` release depends on before importing it.

## Signature

```ts
import type { ShaderSource } from "@vgpu/wgsl";

declare function prepareShader(
  source: string | Pick<ShaderSource, "wgsl" | "functionExports">,
  path?: string,
): ShaderSource;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| source | `string \| Pick<ShaderSource, "wgsl" \| "functionExports">` | ✔ | — | The WGSL to prepare: either the string itself or an object carrying it. A `ResolvedShader` from `resolveShader()` and a legacy v1 `ShaderSource` both fit the object form. |
| source.wgsl | string | ✔ (object form) | — | Complete WGSL for one module, reflected exactly as given. It must be an own data property; accessors are rejected without being called. |
| source.functionExports | `readonly ShaderFunctionExport[]` | ✖ | absent | Authored `export fn` identities to carry into the artifact. When present it must be an array of `{ name, resolvedName, parameterNames }` records; each record and its `parameterNames` array is copied, so the arrays and objects you pass are never frozen or aliased. An explicit `[]` stays `[]`; an absent property stays absent. An own property set to `undefined` is present and invalid, so omit it instead. Duplicate authored `name`s are allowed. |
| source.version, source.reflection, source.sourceChecksum, source.producer | — | ✖ | ignored | Never read. Reflection, checksum, and producer are always recomputed from `wgsl`, so stale metadata on an old artifact is never carried forward. |
| path | nonempty string | ✖ | `"<runtime>"` | Diagnostic context passed to reflection. Pass the file path when you have one; most lexer and parser diagnostics name it, but some retained reflection and layout errors (for example `VGPU-WGSL-REFLECT-BOOL-HOST-SHAREABLE`) omit it from their message. |

**Returns:** `ShaderSource` — a new, deeply frozen plain-data object that is JSON- and `structuredClone`-safe; optional properties are omitted rather than set to `undefined`. The root, `reflection`, every nested object and array, `functionExports`, and each `parameterNames` array are frozen, so assigning to any of them throws in strict mode. Its fields:

- `version: 2` — artifact format version, independent of package versions.
- `wgsl` — the exact input string, unmodified.
- `reflection` — `ShaderReflection` for that string: every binding, entry point, override, required feature, alias, struct, and host-shareable layout that `reflectSource()` reports. Every entry point has `bindings` and `samplingPairs` arrays, including unselected entries.
- `sourceChecksum` — `"fnv1a64-utf16le-v1:"` followed by 16 lowercase hex digits.
- `producer` — `"@vgpu/wgsl/prepare-v2"`.
- `functionExports` — copied from the object input when present; absent for string input and when the input omits it.

**Throws:**

- `VGPU-SHADER-SOURCE-INVALID` when `source` is neither a string nor an object with an own string `wgsl` data property, when `path` is not a nonempty string, or when a present `functionExports` is not an array of valid function-export records (including accessor-backed fields and explicit `undefined`) — pass plain data with the documented shape and omit `functionExports` when unavailable.
- `VGPU-WGSL-REFLECT-SOURCE-IMPORT` when the WGSL contains a top-level `import` — `prepareShader()` reflects one module, not an import graph. Import the file through the Vite/webpack loader, or call `resolveShader()` (`@vgpu/wgsl/runtime`) and prepare its result.
- The existing `VGPU-WGSL-*` lexer, parser, and reflection diagnostics for malformed WGSL or invalid host-shareable layouts, unchanged by preparation — fix the WGSL the diagnostic reports. `path` is supplied as diagnostic context, but individual reflection and layout errors may not include it.

## Examples

```ts
import { prepareShader } from "@vgpu/wgsl/prepare";

const particleShader = prepareShader(
  `
@group(0) @binding(0) var<storage, read_write> particles: array<vec4f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  particles[id.x] += vec4f(0.0, -0.01, 0.0, 0.0);
}
`,
  "shaders/particles.wgsl", // diagnostics name this path instead of "<runtime>"
);

console.log(particleShader.version, particleShader.producer); // 2 "@vgpu/wgsl/prepare-v2"
console.log(particleShader.reflection.entryPoints[0]?.workgroupSize); // [64, 1, 1]
```

Prepare runtime WGSL once, then pass the artifact to the renderer. This is the migration for code that used to pass a raw string to `effect`, `draw`, or `compute`:

```ts
import { effect, init } from "vgpu";
import { prepareShader } from "@vgpu/wgsl/prepare";

const gpu = await init();
const pulseSource = `
@group(0) @binding(0) var<uniform> time: f32;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, 0.5 + 0.5 * sin(time), 1.0);
}
`;

// Before: effect(gpu, pulseSource)
const pulseEffect = effect(gpu, prepareShader(pulseSource)); // prepare once, outside the frame loop
```

Prepare resolver output from its final `wgsl` and `functionExports`. `prepareShader()` reflects `resolved.wgsl` again and ignores `resolved.reflection`, which can describe the source before identifier minification:

```ts
import { resolveShader } from "@vgpu/wgsl/runtime";
import { prepareShader } from "@vgpu/wgsl/prepare";

const entry = "src/shaders/scene.wgsl";
const resolved = await resolveShader({ entry, validate: "off", minify: true });

const sceneShader = prepareShader(resolved, entry); // keeps resolved.functionExports
```

Upgrade a legacy v1 asset. The object form keeps its function-export metadata and discards the old version:

```ts
import type { ShaderFunctionExport, ShaderSource } from "@vgpu/wgsl";
import { prepareShader } from "@vgpu/wgsl/prepare";

interface LegacyShaderAsset {
  readonly version: 1;
  readonly wgsl: string;
  readonly functionExports?: readonly ShaderFunctionExport[];
}

function upgradeShaderAsset(asset: LegacyShaderAsset, assetPath: string): ShaderSource {
  return prepareShader(asset, assetPath); // version 1 is ignored; functionExports is copied
}
```

Prepare in a build script to keep the parser out of the browser. The output is ordinary JSON:

```ts
import { readFile, writeFile } from "node:fs/promises";
import { prepareShader } from "@vgpu/wgsl/prepare";

const shaderPath = "src/shaders/post.wgsl";
const postShader = prepareShader(await readFile(shaderPath, "utf8"), shaderPath);

await writeFile("src/shaders/post.shader.json", JSON.stringify(postShader));
```

## Notes

- **Parser cost.** `prepareShader()` runs the full WGSL scanner, parser, and reflection. Importing `@vgpu/wgsl/prepare` from browser code bundles all of it into that consumer. For static shaders, import `.wgsl` files through the Vite/webpack loader or ship prebuilt artifacts: the renderer then reads the prepared metadata and never loads the parser.
- **Placement.** `prepareShader()` keeps no cache — every call reparses and returns a new artifact. Prepare once per source revision, outside `frame(gpu)` and `frameLoop(gpu)` callbacks, and reuse that one artifact for every `draw`/`effect`/`compute` built from that source.
- **Frozen artifacts are validated once.** The renderer fully validates an artifact the first time it sees it. Because every `prepareShader()` result is deeply frozen, nothing it consumed can change afterwards, so the renderer keeps the validated snapshot and later `draw`/`effect`/`compute` calls with the same artifact — on any `gpu` — reuse it instead of validating again. Per-draw state (labels, `set` values, bindings, uniform buffers, pipelines) is never shared. The snapshot is weakly keyed by the artifact object, so it lives only as long as the artifact does; an imported module that keeps its artifact keeps the snapshot too. This changes nothing about GPU resource disposal.
- **Copies are valid but mutable.** `structuredClone`, a `JSON.parse(JSON.stringify(...))` round trip, an object spread `{ ...shader }` (the root is a new mutable object), and a hand-built object are not frozen. The renderer accepts them, but revalidates them on every construction and never freezes or retains them. A root-only `Object.freeze` does not qualify either: reuse needs every nested object frozen, and a root-only `Object.isFrozen` check is never proof that the whole artifact is safe. For these mutable artifacts the renderer remembers only the checksum of unchanged `wgsl` text; it still compares the supplied `sourceChecksum` every time and rehashes changed text.
- **Exact-source reflection only.** `prepareShader()` does not resolve imports, minify, compile a native shader module, or acquire a GPU device. It is synchronous and works without WebGPU. Errors that only the native WGSL compiler detects still surface when the renderer creates the shader module.
- **Workgroup sizes.** An axis the reflection reads as a plain numeric literal stays a number, even when the device will later reject it; device limits are not checked here. Any other axis — a named `const` or `override`, or a suffixed literal such as `64u` — is serialized as `"unresolved"` and left to native pipeline validation. Omitted axes are `1`.
- **Metadata trust limits.** `sourceChecksum` is FNV-1a 64 over the UTF-16 code units of `wgsl` with no normalization, so `\r\n` and `\n` sources differ. It detects accidental replacement of the `wgsl` text after preparation. It does not authenticate the artifact, prove that `reflection` matches the WGSL, or detect a stale artifact whose fields are internally consistent. Trust artifacts from supported producers — this helper and the vgpu Vite/webpack loaders — and regenerate them whenever the source or the tooling version changes. Do not hand-write or hand-edit `reflection`.
- **`producer` and `version`.** `producer` names the implementation and format (`"@vgpu/wgsl/prepare-v2"`), not a package release. The renderer checks compatibility by `version`; record package versions separately if you need provenance.
- **Renderer rejection.** `draw`, `effect`, and `compute` accept only prepared artifacts. They throw `VGPU-SHADER-SOURCE-UNPREPARED` for a raw string or a v1 artifact, `VGPU-SHADER-SOURCE-VERSION` for an unsupported `version`, and `VGPU-SHADER-SOURCE-INVALID` for missing or malformed fields or a checksum mismatch — rebuild with compatible tooling, or call `prepareShader()`.
- **Output stays unpacked.** `prepareShader()` always returns the full plain object described under Returns — no compact tables, shared records, or decoder imports — so `JSON.stringify` and `structuredClone` copy it completely. Only the Vite/webpack loaders may emit large metadata compactly, and their generated module's default export still evaluates to the same v2 value that `prepareShader({ wgsl, functionExports })` returns for the final WGSL.
- **Loader defaults and earlier diagnostics.** The Vite/webpack loaders prepare every `.wgsl` module — ordinary leaves with `functionExports: []`, import graphs and direct exports from the resolver's final WGSL — and emit a module with no parser import whose default export is that prepared artifact. Ordinary leaves used to ship without reflection, so reflection-detectable parse and layout errors in them (for example a `bool` in a uniform struct) that previously surfaced at runtime now fail the build. Reflection is not device validation: errors only the native WGSL compiler detects still ship; gate them with `npx vgpu check --require-validation`.
- **What does not migrate.** `reflectSource()` (`@vgpu/wgsl/reflect-source`) and `compile()` (`@vgpu/wgsl`) keep their existing string contracts — `compile()` still returns the same `ResolvedShader`, which is not a renderer input — and raw strings passed to a native `device.createShaderModule({ code })` are unaffected. `vgpu/three` keeps accepting raw strings, structural `{ wgsl, functionExports }` objects, and v1 artifacts.
- Do not call `prepareShader(source)` inside a frame callback. When the WGSL or its metadata changes, prepare a new artifact (call `prepareShader()` again, or rebuild through the loader) instead of editing an existing one; never edit `reflection` by hand. A new artifact is a new identity, so it is validated once on its own first use.
- **See also:** `ShaderSource`, `ShaderReflection`, `ShaderFunctionExport`, `reflectSource` (`@vgpu/wgsl/reflect-source`), `resolveShader` (`@vgpu/wgsl/runtime`), `wgslVitePlugin` (`@vgpu/wgsl/loader-vite`), `wgslWebpackLoader` (`@vgpu/wgsl/loader-webpack`).
