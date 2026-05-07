# @vgpu/wgsl

> 0.0.1 — early preview

`@vgpu/wgsl` packages the shader-side utilities in vgpu. The top-level entry handles direct WGSL compilation for plain source strings, while sub-exports cover import resolution at runtime and integration points for webpack and vite. In 0.0.1 this package is the bridge between raw WGSL text and the shader modules consumed by `@vgpu/core` and `@vgpu/render`.

## Install

```bash
pnpm add @vgpu/wgsl
```

## Exports

### `@vgpu/wgsl`
- `compile`
- types: `ResolvedShader`, `SourceMap`, `WGSLAst`, `WGSLSource`

### `@vgpu/wgsl/runtime`
- `resolveShader`
- types: `ResolveOptions`, `WGSLModule`, `WGSLAst`, `SourceMap`, `ResolvedShader`

### `@vgpu/wgsl/loader-webpack`
- default export: `wgslWebpackLoader`

### `@vgpu/wgsl/loader-vite`
- `transformWgsl`
- default export: `wgslVitePlugin`
- type: `ViteLoadResult`

## Usage

### `@vgpu/wgsl`

```ts
import { compile } from "@vgpu/wgsl";

const shader = compile(`@compute @workgroup_size(1) fn main() {}`);
console.log(shader.kind, shader.entryPoints);
```

### `@vgpu/wgsl/runtime`

```ts
import { resolveShader } from "@vgpu/wgsl/runtime";

const resolved = await resolveShader({
  entry: "/triangle.wgsl",
  modules: {
    "/triangle.wgsl": `@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(0.0, 0.5), vec2f(-0.5, -0.5), vec2f(0.5, -0.5));
      return vec4f(p[i], 0.0, 1.0);
    }`,
  },
  validate: false,
});
```

### `@vgpu/wgsl/loader-webpack`

```ts
import wgslWebpackLoader from "@vgpu/wgsl/loader-webpack";

// Add wgslWebpackLoader to your webpack rule for .wgsl files.
void wgslWebpackLoader;
```

### `@vgpu/wgsl/loader-vite`

```ts
import wgslVitePlugin, { transformWgsl } from "@vgpu/wgsl/loader-vite";

const plugin = wgslVitePlugin();
const result = await transformWgsl("@compute @workgroup_size(1) fn main() {}", "/shader.wgsl");
void plugin;
void result;
```

## License

MIT.
