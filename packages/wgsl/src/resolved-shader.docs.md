# ResolvedShader and ShaderSource

Data shapes returned or consumed by the WGSL helpers. Use `ShaderSource` for the prepared shader artifacts that `draw`, `effect`, and `compute` consume, `ShaderReflection` for the metadata inside them, `ResolvedShader` for `compile()` output, and `isShaderFunctionExport()` to check unknown function-export metadata at an integration boundary.

## Import

```ts
import { isShaderFunctionExport } from "@vgpu/wgsl";
import type {
  ResolvedShader,
  ShaderFunctionExport,
  ShaderReflection,
  ShaderSource,
  SourceMap,
  WGSLAst,
  WGSLSource,
} from "@vgpu/wgsl";
```

`vgpu`, `vgpu/node`, `vgpu/mock`, and `vgpu/client` re-export `ShaderSource`, `ShaderReflection`, and `ShaderFunctionExport` as the same types.

## Signature

```ts
import type { EntryPointInfo, Reflection } from "@vgpu/wgsl/reflect-source";

interface ShaderFunctionExport {
  readonly name: string;
  readonly resolvedName: string;
  readonly parameterNames: readonly string[];
}

declare function isShaderFunctionExport(
  value: unknown,
): value is ShaderFunctionExport;

type ShaderReflection = Omit<Reflection, "entryPoints"> & {
  readonly entryPoints: readonly (Omit<
    EntryPointInfo,
    "workgroupSize" | "bindings" | "samplingPairs"
  > & {
    readonly workgroupSize?: readonly [
      number | "unresolved",
      number | "unresolved",
      number | "unresolved",
    ];
    readonly bindings: NonNullable<EntryPointInfo["bindings"]>;
    readonly samplingPairs: NonNullable<EntryPointInfo["samplingPairs"]>;
  })[];
};

interface ShaderSource {
  readonly version: 2;
  readonly wgsl: string;
  readonly reflection: ShaderReflection;
  readonly sourceChecksum: string;
  readonly producer: string;
  readonly functionExports?: readonly ShaderFunctionExport[];
}

interface WGSLSource {
  readonly text: string;
  readonly path?: string;
  readonly imports?: readonly { readonly path: string; readonly from: string }[];
}

interface SourceMap {
  readonly version: 1;
  readonly mappings: readonly [];
}

interface WGSLAst {
  readonly version: 1;
  readonly modules: readonly [{ readonly path: string; readonly text: string }];
  readonly diagnostics: readonly [];
  readonly sourceMap: SourceMap;
  readonly cacheKey: Record<string, string>;
}

interface ResolvedShader {
  readonly kind: "wgsl";
  readonly wgsl: string;
  readonly source: WGSLSource;
  readonly ast: WGSLAst;
  readonly sourceMap: SourceMap;
  readonly diagnostics: readonly [];
  readonly cacheKey: Record<string, string>;
  readonly entryPoints: readonly string[];
  readonly stats: { readonly lines: number; readonly bytes: number; readonly bindGroups: number };
}
```

## Parameters

`ResolvedShader` fields:

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| kind | `"wgsl"` | ✔ | — | Discriminant for WGSL shader data returned by `compile()`. |
| wgsl | string | ✔ | — | Original source string passed to `compile()`. |
| source | `WGSLSource` | ✔ | — | Runtime source metadata. `compile()` sets `text` to the input, `path` to `"<runtime>"`, and `imports` to `[]`. |
| ast | `WGSLAst` | ✔ | — | Lightweight passthrough AST metadata with one runtime module and no diagnostics. |
| sourceMap | `SourceMap` | ✔ | — | Passthrough v1 source map with empty `mappings`. |
| diagnostics | `readonly []` | ✔ | — | Always empty for `compile()` output. |
| cacheKey | `Record<string, string>` | ✔ | — | Deterministic FNV-style key in the form `vgpu-wgsl-1:<hash>` under `default`. |
| entryPoints | `readonly string[]` | ✔ | — | Names of top-level functions carrying an exact `@vertex`, `@fragment`, or `@compute` attribute, in source order. Other attributes may surround the stage attribute; comments and function bodies are ignored, and Unicode XID names retain their original spelling. This is lexical metadata and does not validate WGSL semantics. |
| stats | `{ lines: number; bytes: number; bindGroups: number }` | ✔ | — | Line count, UTF-8 byte length, and `bindGroups: 0`. |

### ShaderSource

A prepared shader artifact: one final WGSL module plus the reflection that `draw`, `effect`, and `compute` read bindings, entry points, and layouts from, so the renderer never parses WGSL. The `@vgpu/wgsl` Vite/webpack loaders emit one for every `.wgsl` import at build time; `prepareShader()` from `@vgpu/wgsl/prepare` builds one from a string, a `resolveShader()` result, or a legacy v1 asset. It is plain JSON-compatible data. Artifacts from the loaders and `prepareShader()` are deeply frozen, which lets the renderer validate them once and reuse the result.

```ts
import type { ShaderSource } from "@vgpu/wgsl";
import postShader from "./post.wgsl"; // the loader emits a ShaderSource

const artifact: ShaderSource = postShader;
console.log(artifact.version, artifact.producer); // 2 "@vgpu/wgsl/prepare-v2"
```

Fields:

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| version | `2` | ✔ | — | Artifact format version, independent of package versions. The renderer checks compatibility by this field alone. |
| wgsl | string | ✔ | — | The exact final WGSL — after import resolution, dead-code elimination, and minification when a loader produced it. |
| reflection | `ShaderReflection` | ✔ | — | Reflection of exactly `wgsl`. Produce it with a supported producer; never hand-write or hand-edit it. |
| sourceChecksum | string | ✔ | — | `"fnv1a64-utf16le-v1:"` plus 16 lowercase hex digits: FNV-1a 64 over the UTF-16 code units of `wgsl`, with no normalization. |
| producer | string | ✔ | — | Nonempty name of the implementation and format that built the artifact. The built-in producer is `"@vgpu/wgsl/prepare-v2"`; other nonempty strings are accepted. |
| functionExports | `readonly ShaderFunctionExport[]` | ✖ | absent | Authoritative identity for surviving direct `export fn` declarations. vgpu loaders always emit the property, including `[]`; `prepareShader()` copies it from object input and omits it for string input. |

### ShaderReflection

The reflection stored in `ShaderSource.reflection`. It is `reflectSource()`'s `Reflection` (`@vgpu/wgsl/reflect-source`) with a serializable entry-point shape, so the artifact survives `JSON.stringify` and `structuredClone` unchanged.

```ts
import type { ShaderReflection } from "@vgpu/wgsl";
import { prepareShader } from "@vgpu/wgsl/prepare";

const reflection: ShaderReflection = prepareShader(`
@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@compute @workgroup_size(64) fn main() {}
`).reflection;

console.log(reflection.bindings[0]?.name); // "cells"
console.log(reflection.entryPoints[0]?.workgroupSize); // [64, 1, 1]
```

Fields:

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| bindings, overrides, featuresRequired, aliases, structs, hostShareableLayouts | as in `Reflection` | ✔ | — | Same shapes and meaning as `reflectSource()` output for the same WGSL. |
| entryPoints | readonly entry-point records | ✔ | — | Every `@vertex`, `@fragment`, and `@compute` entry, selected or not. Each keeps `name`, `mangledName`, `stage`, and optional `inputs` from `EntryPointInfo`. |
| entryPoints[].bindings | `readonly BindingRef[]` (`@vgpu/wgsl/reflect-source`) | ✔ | — | Always present, `[]` when the entry uses no resources. Scoped to the entry and its transitive callees. |
| entryPoints[].samplingPairs | `NonNullable<EntryPointInfo["samplingPairs"]>` | ✔ | — | Always present, `[]` when the entry samples nothing. |
| entryPoints[].workgroupSize | `readonly [number \| "unresolved", number \| "unresolved", number \| "unresolved"]` | ✖ | absent | Compute entries only. A plain numeric literal stays a number; an axis reflection cannot read as one — a named `const` or `override`, or a suffixed literal such as `64u` — is `"unresolved"` and left to native pipeline validation. |

### ShaderFunctionExport

Fields:

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| name | string | ✔ | — | Authored direct-export name. Import aliases do not create entries. |
| resolvedName | string | ✔ | — | Exact declaration identifier in final WGSL, after mangling and optional identifier minification. |
| parameterNames | `readonly string[]` | ✔ | — | Authored parameter names in declaration order. Types and return values remain in the final WGSL header. |

**Returns:** These are TypeScript interfaces, not callables. They return nothing.

**Throws:** These type declarations throw nothing. `compile()` throws before constructing `ResolvedShader` when runtime WGSL contains a top-level import.

## isShaderFunctionExport

Checks whether one unknown value has the public `ShaderFunctionExport` shape and uses valid WGSL declaration identifiers. Use it when accepting metadata from a third-party loader, serialized data, or another untyped integration. Artifacts produced and consumed entirely by matching vgpu packages normally do not need a separate manual check.

The canonical import belongs to `@vgpu/wgsl`:

```ts
import {
  isShaderFunctionExport,
  type ShaderFunctionExport,
} from "@vgpu/wgsl";

function readFunctionExport(
  value: unknown,
): ShaderFunctionExport | undefined {
  return isShaderFunctionExport(value) ? value : undefined;
}

const metadata = readFunctionExport({
  name: "surfaceColor",
  resolvedName: "a",
  parameterNames: ["position", "timeSeconds"],
});

console.log(metadata?.resolvedName);
```

Applications that already depend on the main package can use its convenience re-export without installing or importing a second package directly:

```ts
import { isShaderFunctionExport } from "vgpu";

const candidate: unknown = {
  name: "surfaceColor",
  resolvedName: "a",
  parameterNames: ["position", "timeSeconds"],
};

if (isShaderFunctionExport(candidate)) {
  console.log(candidate.parameterNames);
}
```

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| value | unknown | ✔ | — | One possible `ShaderFunctionExport` record. Additional properties are allowed. |

Valid identifiers use ASCII letters, digits, and underscores, cannot be `_` or start with `__`, and cannot be WGSL keywords or reserved words (including the legacy `binding_array` reservation).

**Returns:** `value is ShaderFunctionExport` — `true` only when `name`, `resolvedName`, and every member of `parameterNames` are valid declaration identifiers and parameter names are unique. The predicate narrows `value` for TypeScript.

**Throws:** Nothing. Malformed values, including values whose properties cannot be read, return `false`.

The check is structural and syntactic. It does not parse shader text, prove that `resolvedName` exists in final WGSL, compare parameter or return types, validate arity, validate a surrounding `ShaderSource`, or detect duplicate authored names across multiple export records. Consumer adapters such as `tslExports()` perform the source-specific checks they require after this predicate succeeds.

## Examples

A loader import is already a `ShaderSource`; pass it to the renderer unchanged:

```ts
import { init, effect } from "vgpu";
import vignetteShader from "./vignette.wgsl";

const gpu = await init();
const vignette = effect(gpu, vignetteShader); // no parser in the browser bundle
```

`compile()` returns a `ResolvedShader`, not a renderer input. Prepare its WGSL before passing it to a renderer:

```ts
import { compile, type ResolvedShader, type ShaderSource } from "@vgpu/wgsl";
import { prepareShader } from "@vgpu/wgsl/prepare";

const resolved: ResolvedShader = compile(`
@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`);

const source: ShaderSource = prepareShader(resolved.wgsl);
console.log(resolved.entryPoints[0], source.reflection.entryPoints[0]?.stage); // "fs_main" "fragment"
```

Accept artifacts at an integration boundary by type, and let the renderer validate them:

```ts
import type { ShaderSource } from "@vgpu/wgsl";

function describeShader(shader: ShaderSource): string {
  const stages = shader.reflection.entryPoints.map((entry) => `${entry.stage}:${entry.name}`);
  return `${shader.producer} v${shader.version} — ${stages.join(", ")}`;
}
```

## Notes

- `ShaderSource` is `version: 2`. Renderers throw `VGPU-SHADER-SOURCE-UNPREPARED` for raw strings and v1 artifacts, `VGPU-SHADER-SOURCE-VERSION` for other integer versions, and `VGPU-SHADER-SOURCE-INVALID` for malformed fields or checksum mismatches. Rebuild with matching tooling/runtime versions, regenerate prebuilt assets, or call `prepareShader()`; object input keeps `functionExports`.
- **Validation and reuse.** The renderer fully validates an artifact (WGSL checksum and reflection) the first time it sees it and keeps its own frozen, device-independent snapshot, never the object you passed. When all consumed data — the artifact object itself, `reflection`, `functionExports`, and every object and array inside them — was already frozen, which holds for loader imports and `prepareShader()` results, later `draw`/`effect`/`compute` calls with the same artifact on any `gpu` reuse that snapshot instead of validating again. Objects reachable only through extra, unconsumed properties need not be frozen. Per-instance labels, `set` values, and binding assignments stay independent; existing GPU caches (pipelines, shader modules, layouts), explicit resource sharing such as a `uniforms()` object bound twice, and GPU resource disposal are unchanged. Artifacts whose consumed data is not entirely frozen, such as a `structuredClone` or JSON copy, an object spread (mutable root), a root-only `Object.freeze`, or a typical hand-built object, are valid but are revalidated on every call and never frozen or retained by vgpu, so mutating them afterwards does not affect existing handles. For those, only the checksum of unchanged `wgsl` text is remembered; the supplied `sourceChecksum` is still compared every time and changed text is rehashed. An invalid artifact throws on every call. The cache keys are weak and do not keep an artifact alive, but a live `draw`/`effect`/`compute` keeps the reflection it uses until its `dispose()` and an imported module can keep its artifact for the session; collection timing is not guaranteed. Import `.wgsl` modules at module level or call `prepareShader()` once per source revision. To change the WGSL or its metadata, prepare or rebuild a new artifact — it is validated once on its first use — and never edit `reflection`. Prepared metadata is trusted, not verified: the checksum detects accidental replacement of `wgsl`, but it does not authenticate the artifact, prove that `reflection` matches `wgsl`, or detect a stale artifact whose fields agree with each other. Regenerate artifacts whenever the source or the tooling version changes.
- `functionExports` is optional in TypeScript so artifacts without direct-export metadata remain assignable, but every vgpu loader artifact emits it. Property presence is authoritative: `[]` exposes no callable direct exports, while absence denotes an artifact without that metadata.
- `functionExports` contains only direct `export fn` declarations that survive graph emission and DCE. It does not root otherwise-dead declarations, publish import aliases, or include source paths.
- `isShaderFunctionExport()` validates declaration identifiers, not the stricter set of names a code generator may choose for minification. Predeclared identifiers remain syntactically valid metadata names.
- `ShaderReflection` is not a different reflection model. Its only differences from `Reflection` are required per-entry `bindings`/`samplingPairs` arrays and the `"unresolved"` workgroup marker; `reflectSource()` and `resolveShader()` keep returning `Reflection`.
- Treat `ResolvedShader` fields as read-only data. Do not patch placeholder AST internals to represent imports; use `resolveShader()` for import graphs.
- `compile()` output does not prove WGSL validity. It only packages the string and rejects top-level `import`.
- Pure-module contract for resolver graphs: imported modules may export structs/functions/constants/aliases, but no imported module may declare `@group/@binding`; declare resources only in the entry module.
- **`entryPoints` here is not reflection.** `ResolvedShader.entryPoints` (this page, `compile()`'s output) is just a lexical `readonly string[]` of entry-point names. It does not validate stage signatures or expose stage, workgroup size, inputs, bindings, or sampling pairs. The reflection `EntryPointInfo[]` returned by `reflectSource()` and by `resolveShader()`'s `ResolvedShader.reflection.entryPoints` (`@vgpu/wgsl/runtime`) carries that semantic metadata. If you need it, reach for `reflectSource` (`npx vgpu docs cat /@vgpu/wgsl/reflect-source/reflect-source.docs.md`) or `resolveShader`, not `compile()`.
- **See also:** `prepareShader` (`@vgpu/wgsl/prepare`), `compile`, `resolveShader`, `reflectSource`, `wgslVitePlugin`, `wgslWebpackLoader`.
