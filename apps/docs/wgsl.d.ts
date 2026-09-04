/**
 * What `@vgpu/wgsl`'s webpack/turbopack loader actually emits for a `*.wgsl`
 * import: the v1 artifact, NOT a bare string.
 *
 * This used to be declared as `string`, which typechecked fine everywhere
 * because `gpu.effect()` accepts either shape — and then broke at runtime the
 * first time something tried to read the source (`source.match is not a
 * function`). Keep it honest; mirror `@vgpu/wgsl`'s own `wgsl-types.d.ts`.
 */
declare module '*.wgsl' {
  const source: import('vgpu/client').ShaderSource;
  export default source;
}
