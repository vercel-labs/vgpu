# Example: an unchanged scene that keeps allocating

This is an editorial example inspired by managed-uniform caching. Recheck the relevant revision
before using it in a real explanation; it is not a current API specification or benchmark receipt.

## The problem — before the fix

"The application rendered the same scene again, but the library created new binding objects.
The following steps show why the old implementation missed the cache."

Before the first snippet, state that the device, shader, render target and draw already exist.
Use a small excerpt from the actual reproduction. For example, if these calls match that revision:

```typescript
function render() {
  return frame(gpu, f => {
    f.pass(out, pass => {
      mesh.set({ object: { world } }); // Same matrix values.
      pass.draw(mesh);
    });
  });
}

await render().done;
await render().done;
```

Then follow this one example:

1. The user supplied unchanged values. Explain any validation and packing work.
2. Recording the draw needed a snapshot. Explain why a later value must not overwrite an
   earlier draw's input. Put a small diagram of two values and two ranges here.
3. The old key included an identifier that changed each frame. Show just the old and next key
   in a second diagram. Explain the resulting cache miss in ordinary prose.

## The solution — after the fix

"The same user code runs unchanged. The new implementation changes how it identifies and reuses
completed ranges."

Explain stable identities and the completion boundary with a third small diagram. Discuss equal
values separately from cross-frame reuse: skipping redundant calls alone may not fix the cache
identity. Include the remaining work and exceptions. If the fix is not implemented, rename this
section "Proposed solution" and avoid claims that it already works.

## Results and remaining limits

Add measured numbers only when a receipt identifies the workload, environment and revision.
An allocation reduction alone does not establish lower GPU execution time. A failed CPU target
must remain visible even when the allocation target passed.

## Counterexamples to avoid

| Confusing presentation | Correction |
| --- | --- |
| "Start with the user's code" followed by a snippet with no context | First label the problem and tell the reader this traces the old behavior. |
| Fixes appear halfway through the problem walkthrough | Finish the causal chain, then introduce an explicit solution heading. |
| A new raw-buffer behavior appears under "What does not change" | Move it to changed behavior or technical scope. |
| The whole PDF becomes a tall image in the PR | Keep paragraphs and code in Markdown; attach only small SVG diagrams. |
| A wide SVG has many tiny paragraphs | Move prose outside it and split the diagram into focused chunks. |
| "Zero allocations means faster GPU rendering" | State the measured allocation result and leave GPU throughput unclaimed. |
| An unreleased feature is described as a verified fix | Label its status and separate design expectations from actual validation. |
