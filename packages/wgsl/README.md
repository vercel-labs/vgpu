# @vgpu/wgsl

`@vgpu/wgsl` turns WGSL files into JavaScript string modules and resolves WGSL-to-WGSL imports before bundling. It includes a resolver/runtime, webpack and Vite integrations, and a TypeScript ambient-types sub-export for `import shader from "./shader.wgsl"`.

The resolver preserves shader entry-point names for WebGPU pipeline creation while mangling non-entry helpers and imports to avoid cross-module symbol collisions. Loader integrations also wire transitive `.wgsl` imports into bundler watch/HMR systems.

## Installation

```bash
pnpm add @vgpu/wgsl
npm install @vgpu/wgsl
yarn add @vgpu/wgsl
```

## TypeScript setup

Add a project `.d.ts` file (for example `wgsl-env.d.ts`):

```ts
/// <reference types="@vgpu/wgsl/wgsl-types" />
```

Or add the package type to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["@vgpu/wgsl/wgsl-types"]
  }
}
```

This is required for TypeScript to accept `.wgsl` imports. If you cannot use the sub-export, a local fallback is:

```ts
declare module "*.wgsl" {
  const source: string;
  export default source;
}
```

## Bundler integrations

### Webpack 5

Recommended rule:

```js
module.exports = { module: { rules: [{ test: /\.wgsl$/, loader: "@vgpu/wgsl/loader-webpack" }] } };
```

Verbose/options form (advanced):

```js
module.exports = {
  module: {
    rules: [
      {
        test: /\.wgsl$/,
        loader: require.resolve("@vgpu/wgsl/loader-webpack"),
        options: { minify: true },
      },
    ],
  },
};
```

`minify` defaults to `false`; set it to `true` to strip comments and unnecessary whitespace from emitted WGSL.

### Vite 5+

```ts
import { wgslVitePlugin } from "@vgpu/wgsl/loader-vite";

export default { plugins: [wgslVitePlugin()] };
```

Pass `wgslVitePlugin({ minify: true })` to strip comments and unnecessary whitespace from emitted WGSL.

### Next.js / Turbopack (Next >= 15.5)

Recommended string form:

```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: ["@vgpu/wgsl/loader-webpack"],
        as: "*.js",
      },
    },
  },
};

export default config;
```

Verbose/options form (advanced; object loaders require `options` by the Next TypeScript type):

```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: [{ loader: "@vgpu/wgsl/loader-webpack", options: { minify: true } }],
        as: "*.js",
      },
    },
  },
};

export default config;
```

Use legacy `experimental.turbo.rules` on older Next 15.0-15.2 apps. The `as: "*.js"` mapping is required because Turbopack's webpack-loader bridge expects loaders to return JavaScript.

## WGSL syntax

WGSL modules can import named exports from other WGSL files:

```wgsl
import { helper_color } from "./helper.wgsl";

@fragment
fn fs_main() -> @location(0) vec4f {
  return helper_color();
}
```

Imported files export normal WGSL declarations:

```wgsl
export fn helper_color() -> vec4f { return vec4f(0.1, 0.2, 0.3, 1.0); }
```

See `examples/next-wgsl/app/*.wgsl` and `packages/wgsl/tests/*.test.ts` for more examples.

## Mangling and entry-point preservation

Non-entry helpers and imported symbols may be renamed to `_vgsl_<hash>__<name>` to avoid collisions between modules. WebGPU entry-point functions annotated with `@vertex`, `@fragment`, or `@compute` are preserved, so pipeline creation keeps working:

```ts
device.createRenderPipeline({
  layout: "auto",
  vertex: { module, entryPoint: "vs_main" },
  fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
});
```

Bindings and override constants are likewise exposed by their shader-visible names; when a reflected item needs a generated name, use its `mangledName` field.

## Reflection API

```ts
import { resolveShader } from "@vgpu/wgsl/runtime";

const resolved = await resolveShader({ entry: "./shader.wgsl" });
const fragment = resolved.reflection.entryPoints.find((entry) => entry.stage === "fragment");
```

`resolveShader()` returns `{ wgsl, deps, cacheKey, ast, sourceMap, diagnostics, reflection }`. Reflection currently exposes:

| Field | Description |
| --- | --- |
| `reflection.entryPoints` | `{ name, mangledName, stage }` for `@vertex`, `@fragment`, and `@compute` functions. |
| `reflection.bindings` | `{ group, binding, name }` for discovered resource bindings. |
| `reflection.overrides` | `{ name, mangledName, defaultValue? }` for override constants. |
| `reflection.featuresRequired` | Feature names from `enable ...;` directives. |

Workgroup sizes, binding access types, and struct layouts are not yet exposed.

## Minify option

`resolveShader`, `@vgpu/wgsl/loader-webpack`, `@vgpu/wgsl/loader-vite`, and `transformWgsl` default to `minify: false`, preserving previous output. Set `minify: true` to strip comments and unnecessary whitespace from leaf shaders and resolved import graphs:

```ts
import { transformWgsl, wgslVitePlugin } from "@vgpu/wgsl/loader-vite";
import { resolveShader } from "@vgpu/wgsl/runtime";

const resolved = await resolveShader({ entry: "./shader.wgsl", minify: true });
const vite = wgslVitePlugin({ minify: true });
const transformed = await transformWgsl(source, "/shader.wgsl", { minify: true });
void resolved;
void vite;
void transformed;
```

The minifier only removes comments and whitespace. It does not rename identifiers: entry point names, uniform/resource names, override names, and other JavaScript-visible WGSL names remain stable. Existing import flattening and collision-avoidance mangling is unchanged. When validation is enabled, `resolveShader()` validates the unminified emitted WGSL before minifying the returned output so diagnostics still map to authored modules.

## HMR behavior

Transitive `.wgsl` imports are registered with each bundler's watch graph:

- Webpack: the loader calls `this.addDependency()` for resolved dependencies.
- Vite/Rollup: the plugin calls `this.addWatchFile()`.
- Turbopack: the webpack-loader bridge tracks patched async `fs.readFile` calls; the resolver uses `fs/promises.readFile` so transitive imports are intercepted. `resolveShader()` does not keep a stale entry-level `resolveCache`, so reloads re-read changed imports.

## API reference

| Export | Purpose |
| --- | --- |
| `@vgpu/wgsl` | `compile()` for plain WGSL source strings plus shared public types. |
| `@vgpu/wgsl/runtime` | `resolveShader()` for file/module graph resolution and reflection. |
| `@vgpu/wgsl/loader-webpack` | Default webpack-compatible `.wgsl` loader. |
| `@vgpu/wgsl/loader-vite` | Default/named `wgslVitePlugin()` and `transformWgsl()`. |
| `@vgpu/wgsl/wgsl-types` | Ambient `declare module "*.wgsl"` types for TypeScript apps. |

## License

MIT.
