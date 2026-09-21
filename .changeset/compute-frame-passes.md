---
"vgpu": minor
"@vgpu/core": patch
---

## Summary

Unify compute and render pipeline preparation with lazy compute compilation, `Compute.compile()` / `compileSync()`, and frame-owned `computePass()` dispatches. Capture managed uniform values per direct frame draw/dispatch. Surface native compute validation, validate dispatch counts and workgroup limits, and wait for synchronous pipeline validation before resolving asynchronous preparation.

## Migration

### Affected usage

Applications using compute, synchronous render compilation, or changing managed uniform values while encoding a frame. This includes code that assumed `compute()` eagerly compiled, relied on invalid dispatch counts being forwarded, or expected the last uniform update to affect every direct draw in a frame.

### Steps

1. Move compute work that belongs to a frame into `frame.computePass()`. Standalone `compute.dispatch()` still submits independently, including inside a frame callback. Frame-owned dispatches execute in render/compute pass order and are discarded on frame cancellation.

#### Before

```ts illustrative
frame(gpu, f => {
  simulation.dispatch(64);
  f.pass(output, display);
});
```

#### After

```ts illustrative
await simulation.compile();
frame(gpu, f => {
  f.computePass(pass => pass.dispatch(simulation, 64));
  f.pass(output, display);
});
```

2. Use `await simulation.compile()` during preparation to receive compilation failure through its rejecting promise. It returns the same compute object. `compileSync()` is the synchronous alternative; native asynchronous validation still uses `gpu.onError`. First dispatch also compiles synchronously. Synchronous native render/compute creation failures now throw rather than silently skipping work; automatic reuse of a failed pipeline throws, and an explicit compile call retries.
3. Register `gpu.onError` for asynchronous execution errors. `gpu.settled()` and `frame.done` remain resolve-only completion signals, not success checks. A subsequent `StorageBuffer.read()` does not establish that an earlier producer succeeded. `compile()` after `compileSync()` now waits for validation, including when synchronous compilation takes over a pending asynchronous compile.
4. Pass finite non-negative integer dispatch counts within the granted device limit. Keep workgroup dimensions and their product within device limits. Device defaults are unchanged; request supported larger limits explicitly through `init({ requiredLimits: ... })` or use smaller workgroups.
5. Set managed uniform values before each direct draw or dispatch that uses them. Later updates no longer overwrite earlier commands' captured values. To use one value everywhere, set it before encoding those commands.

#### Capturing values

```ts illustrative
frame(gpu, f => f.computePass(pass => {
  simulation.set({ dt: 0.01 });
  pass.dispatch(simulation, 64); // uses 0.01
  simulation.set({ dt: 0.02 });
  pass.dispatch(simulation, 64); // uses 0.02
}));
```

Managed capture covers JS-owned uniform bindings and `uniforms()` used in the uniform address space, for both render and compute. Storage bindings (including `uniforms()` adopted as storage), raw/low-level buffers, claimed bind groups, and render bundles keep live buffer contents. Explicit host writes and CPU mutations are outside frame cancellation. For distinct bundle/raw-buffer values in one submission, use separate resources; ordinary host writes are not interleaved frame commands.

Compute-pass callbacks must be synchronous. Await preparation before entering them, and do not retain their pass object after the callback returns. Passes cannot nest, and submission/cancellation must occur after the pass ends.

### Verification

Await compilation and handle rejection; collect asynchronous `gpu.onError` events and await completion before inspecting them. Verify mixed render/compute output and distinct per-operation uniforms on a real GPU. Assert that a frame containing several dispatches submits once, cancellation submits none of its work, and GPU-written storage and indirect arguments persist across dispatches.
