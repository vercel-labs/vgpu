# resolveShader

Loads a WGSL entry module, resolves vgpu WGSL imports, enforces pure imported modules, and emits one plain WGSL string. Use it in build/setup/tooling code when shader source is split across files or in-memory modules.

## Import

```ts
import { resolveShader } from "@vgpu/wgsl/runtime";
import type { ResolveOptions, ResolvedShader } from "@vgpu/wgsl/runtime";
```

## Signature

```ts
import type { ResolvedShader } from "@vgpu/wgsl/runtime";

interface ResolveOptions {
  readonly entry: string;
  readonly rootDir?: string;
  readonly packageMap?: Record<string, string>;
  readonly modules?: Record<string, string>;
  readonly validate?: boolean;
  readonly minify?: boolean | { readonly whitespace?: boolean; readonly identifiers?: "none" | "safe" };
}

declare function resolveShader(opts: ResolveOptions): Promise<ResolvedShader>;
```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| opts.entry | string | ✔ | — | Entry WGSL module path. With `modules`, it is canonicalized against the virtual module map; without `modules`, it is resolved on disk and may omit `.wgsl` when a matching file or `index.wgsl` exists. The entry may declare `@group/@binding` resources. |
| opts.rootDir | string | ✖ | `dirname(entry)` for cache-key grouping; no `@/` alias unless provided | Base directory for `@/foo.wgsl` imports. Also used as the default root passed to cache key generation when present. |
| opts.packageMap | `Record<string, string>` | ✖ | `{}` | Prefix map for package-style WGSL imports. If a specifier starts with a key, the target prefix is joined with the remainder. |
| opts.modules | `Record<string, string>` | ✖ | filesystem reads | In-memory WGSL filesystem. Keys are normalized with `/`; relative imports use virtual paths and package imports require `packageMap`. |
| opts.validate | boolean | ✖ | `true` | When not `false`, validates emitted WGSL via `validateWGSL`. In normal processes validation is a no-op unless `VGPU_DOCKER_TEST=1`; in that mode Naga/WebGPU diagnostics can throw. |
| opts.minify | `boolean | MinifyOptions` | ✖ | `false` | `true` means `{ whitespace: true, identifiers: "safe" }`; object form defaults to `{ whitespace: true, identifiers: "none" }`; `false` or omitted preserves whitespace/comments after resolver emission and DCE. |

**Returns:** `Promise<ResolvedShader>` — resolved WGSL plus dependency paths, cache keys, lightweight AST modules, source map, diagnostics, and reflection for entry points/resources.

**Throws:** `VGPU-RESOLVE-MODULE-BINDING` when a non-entry imported module declares any `@group(...)` or `@binding(...)` resource — move the resource declaration into the entry module and export only structs/functions from the module. The error message is exactly:

```text
VGPU-RESOLVE-MODULE-BINDING: <module> declara '@group(<group>) @binding(<binding>) <name>'.
Los módulos no pueden declarar bindings — exportá el struct y declaralo en tu entry:
  export struct NoiseConfig { seed: u32 }
  // en tu entry: @group(0) @binding(0) var<uniform> cfg: NoiseConfig;
```

**Throws:** `VGPU-WGSL-RES-ABS` when an import specifier starts with `/` — use a relative, `@/`, or package import.
**Throws:** `VGPU-WGSL-RES-NOTFOUND` when the entry/import path or virtual module cannot be found, or when an import path token is not a string — add the module, fix the spelling, or add `.wgsl`/`index.wgsl`.
**Throws:** `VGPU-WGSL-PKG-NOTFOUND` when a package or package export cannot be found — install/map the package or fix `packageMap`/exports.
**Throws:** `VGPU-WGSL-IMP-SELF` when the graph contains an import cycle — break the cycle.
**Throws:** `VGPU-WGSL-IMP-ORDER` when an `import` appears after declarations — move imports before declarations.
**Throws:** `VGPU-WGSL-IMP-SIDEEFFECT` for `import "x"` — import named symbols or a namespace.
**Throws:** `VGPU-WGSL-IMP-DEFAULT` for default import syntax or malformed import bindings — use `import { name } from "..."` or `import * as ns from "..."`.
**Throws:** `VGPU-WGSL-EXP-REEXPORT-CYCLE` for `export { ... }` re-export syntax — export declarations directly.
**Throws:** `VGPU-WGSL-EXP-NOTDECL` for invalid export attributes or exported declarations without a name — attach `export` to a declaration.
**Throws:** `VGPU-WGSL-SYM-NOEXPORT` when an imported binding is not exported by the target module — export it or fix the import name.
**Throws:** `VGPU-WGSL-SYM-IMPORT-SHADOW` when imports conflict with each other or shadow locals — rename with `as` or rename the local declaration.
**Throws:** `VGPU-WGSL-OVERRIDE-DUP` or `VGPU-WGSL-ENTRYPOINT-DUP` when JavaScript-visible override or entry-point names appear in multiple modules — rename one declaration.
**Throws:** `VGPU-WGSL-MANGLE-COLLISION` when canonical path hashes collide — rename one directory in either path.
**Throws:** `VGPU-WGSL-NS-NOTVALUE` or `VGPU-WGSL-NS-NOMEMBER` for invalid namespace use — access exported namespace members directly.
**Throws:** `VGPU-WGSL-MINIFY-IDENTIFIERS` when `minify.identifiers` is not `"none"` or `"safe"` — pass a valid mode.
**Throws:** `VGPU-WGSL-MINIFY-BLOCK`, `VGPU-WGSL-LEX-UNTERM-COMMENT`, or `VGPU-WGSL-LEX-UNTERM-STRING` for unterminated WGSL comments/strings during scanning/minification — close the token.
**Throws:** `VGPU-WGSL-NAGA-UNKNOWN` when validation is active and WebGPU/Naga rejects emitted WGSL or no validation adapter is available — fix the WGSL reported by the diagnostic.

## Examples

```ts
import { resolveShader } from "@vgpu/wgsl/runtime";

const resolved = await resolveShader({
  entry: "/entry.wgsl",
  validate: false,
  modules: {
    "/math.wgsl": `
export fn tint(value: vec3f) -> vec3f {
  return value * vec3f(1.0, 0.5, 0.25);
}
`,
    "/entry.wgsl": `
import { tint } from "./math.wgsl";

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(tint(vec3f(1.0)), 1.0);
}
`,
  },
});

console.log(resolved.wgsl.includes("fs_main"));
```

```ts
import { resolveShader } from "@vgpu/wgsl/runtime";

const resolved = await resolveShader({
  entry: "/entry.wgsl",
  validate: false,
  minify: { whitespace: true },
  modules: {
    "/types.wgsl": `
export struct NoiseConfig { seed: u32 }
export fn noise(cfg: NoiseConfig) -> f32 { return f32(cfg.seed); }
`,
    "/entry.wgsl": `
import { NoiseConfig, noise } from "./types.wgsl";

@group(0) @binding(0) var<uniform> cfg: NoiseConfig;

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(noise(cfg));
}
`,
  },
});

console.log(resolved.deps.length);
```

## Notes

- Imported modules are pure: no `@group`/`@binding` in any non-entry module. Export structs, aliases, constants, and functions from modules; declare uniforms/storage/textures/samplers only in the entry.
- `resolveShader()` is for setup, tests, loaders, and build tooling. Do not call it per frame; resolve and create pipelines off the render hot path.
- Declaration-level DCE always runs before validation/minification when entry points exist. There is no DCE opt-out in this release.
- `minify: true` is the production preset. Safe identifier minification is conservative and does not rename entry points, resources, overrides, structs, fields, import/export names, attributes, builtins, or predeclared WGSL names.
- Validation maps diagnostics back to generated module headers. Columns can be approximate when substituted identifiers appear; those diagnostics include `VGPU-WGSL-COL-APPROX` metadata.
- **See also:** `compile`, `ShaderSource`, `wgslVitePlugin`, `wgslWebpackLoader`, `@vgpu/wgsl-std/hash`.
