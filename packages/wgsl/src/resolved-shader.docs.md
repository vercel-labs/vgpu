# ResolvedShader and ShaderSource

Data shapes returned or consumed by the WGSL helpers. Use `ResolvedShader` for `compile()` output, `ShaderSource` for loader-emitted `.wgsl` modules, and `isShaderFunctionExport()` to check unknown function-export metadata at an integration boundary.

## Import

```ts
import { isShaderFunctionExport } from "@vgpu/wgsl";
import type {
  ResolvedShader,
  ShaderFunctionExport,
  ShaderSource,
  SourceMap,
  WGSLAst,
  WGSLSource,
} from "@vgpu/wgsl";
```

## Signature

```ts
interface ShaderFunctionExport {
  readonly name: string;
  readonly resolvedName: string;
  readonly parameterNames: readonly string[];
}

declare function isShaderFunctionExport(
  value: unknown,
): value is ShaderFunctionExport;

interface ShaderSource {
  readonly version: 1;
  readonly wgsl: string;
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
| entryPoints | `readonly string[]` | ✔ | — | Names matched by `@(vertex|fragment|compute) fn <name>` in the source. |
| stats | `{ lines: number; bytes: number; bindGroups: number }` | ✔ | — | Line count, UTF-8 byte length, and `bindGroups: 0`. |

### ShaderSource

Fields:

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| version | `1` | ✔ | — | Loader artifact version. |
| wgsl | string | ✔ | — | Plain WGSL emitted by a loader or resolver. |
| functionExports | `readonly ShaderFunctionExport[]` | ✖ for legacy producers | absent | Authoritative identity for surviving direct `export fn` declarations. New vgpu loaders always emit the property, including `[]`. |

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

```ts
import { compile, type ResolvedShader, type ShaderSource } from "@vgpu/wgsl";

const resolved: ResolvedShader = compile(`
@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}
`);

const source: ShaderSource = {
  version: 1,
  wgsl: resolved.wgsl,
  functionExports: [],
};
console.log(source.version, resolved.entryPoints[0]);
```

```ts
import type { ShaderSource } from "@vgpu/wgsl";

function acceptsLoaderOutput(shader: ShaderSource): string {
  return shader.wgsl;
}

acceptsLoaderOutput({
  version: 1,
  wgsl: "@compute @workgroup_size(1) fn main() {}",
  functionExports: [],
});
```

## Notes

- `ShaderSource` v1 keeps its original `version` and `wgsl` fields and may add `functionExports`. The field is optional in TypeScript so legacy producers remain assignable, but every new vgpu loader artifact emits it. Property presence is authoritative: `[]` exposes no callable direct exports, while absence denotes a legacy artifact.
- `functionExports` contains only direct `export fn` declarations that survive graph emission and DCE. It does not root otherwise-dead declarations, publish import aliases, or include source paths.
- `isShaderFunctionExport()` validates declaration identifiers, not the stricter set of names a code generator may choose for minification. Predeclared identifiers remain syntactically valid metadata names.
- `ShaderSource` still has no `bindings`, reflection, layouts, or cache metadata; `bindings` is reserved for a future version bump.
- Treat `ResolvedShader` fields as read-only data. Do not patch placeholder AST internals to represent imports; use `resolveShader()` for import graphs.
- `compile()` output does not prove WGSL validity. It only packages the string and rejects top-level `import`.
- Pure-module contract for resolver graphs: imported modules may export structs/functions/constants/aliases, but no imported module may declare `@group/@binding`; declare resources only in the entry module.
- **`entryPoints` here is not reflection.** `ResolvedShader.entryPoints` (this page, `compile()`'s output) is just `readonly string[]` — names matched by a regex over `@(vertex|fragment|compute) fn <name>`, nothing more. It is a different, older, and much simpler shape than the reflection `EntryPointInfo[]` returned by `reflectSource()` and by `resolveShader()`'s `ResolvedShader.reflection.entryPoints` (`@vgpu/wgsl/runtime`), which carries `stage`, `workgroupSize`, `inputs`, `bindings`, and `samplingPairs` per entry point. If you need stage/binding/input data, reach for `reflectSource` (`npx vgpu docs cat /@vgpu/wgsl/reflect-source/reflect-source.docs.md`) or `resolveShader`, not `compile()`.
- **See also:** `compile`, `resolveShader`, `reflectSource`, `wgslVitePlugin`, `wgslWebpackLoader`.
