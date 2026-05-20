# wgslVitePlugin

`wgslVitePlugin` lets Vite import `.wgsl` files as JavaScript string modules. Plain WGSL files are returned as raw source strings, while files with top-level vgpu-wgsl imports are resolved into one plain WGSL string during Vite transform.

`transformWgsl(source, id)` is the testable transform primitive. It accepts the WGSL source and file id, and returns `ViteLoadResult` with JavaScript code plus `map: null`; the code default-exports the original or resolved WGSL string. The default plugin wraps that primitive with `{ name, transform }` and only handles paths ending in `.wgsl`.

Options are optional. `wgslVitePlugin()` and `transformWgsl(source, id)` preserve previous behavior, including byte-for-byte output for leaf shaders. Pass `{ minify: true }` to strip comments and unnecessary whitespace for leaf shaders and resolved import graphs:

```ts
import wgslVitePlugin, { transformWgsl } from "@vgpu/wgsl/loader-vite";

export default {
  plugins: [wgslVitePlugin({ minify: true })],
};

const result = await transformWgsl(source, "/shader.wgsl", { minify: true });
```

Minification only removes comments and whitespace. It does not rename identifiers: entry point names, uniform/resource names, override names, and other JavaScript-visible WGSL names remain stable. Existing import flattening and collision-avoidance mangling for imported shader graphs is unchanged.

Resolution failures, package export problems, invalid imports, and validation-disabled resolver errors surface as structured `VGPU-WGSL-*` exceptions from the transform. Vite catches those exceptions and presents them as transform failures. Module layout is configured through normal file paths, package `exports`, and resolver-compatible source files.
