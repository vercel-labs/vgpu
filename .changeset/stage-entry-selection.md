---
"vgpu": minor
---

## Summary

Make automatic shader entry selection consistent across vertex, fragment, and compute stages.
Explicit selections are validated and take priority. A sole entry works with any name. With
multiple entries of a stage, prefer `vs_main`, `fs_main`, or `cs_main` respectively; if that name
is absent, retain the first entry of the stage. These are vgpu conventions, not WGSL requirements.

Add `effect(gpu, source, { entry: { fragment: "name" } })` to select a fragment explicitly.
Selection is fixed at construction and determines resource layouts as well as the compiled entry.

## Migration

### Affected usage

Code using vgpu 0.5.0 or earlier (or a canary build before this change) that omits an entry selection
and declares a conventional entry after another entry of the same stage now selects the
conventional function. This affects `draw()`, `compute()`, and `effect()`, including effects with
custom vertex stages. It can change pixels, vertex input requirements, compute results, or active
resources. Single-entry shaders and stages without a conventional name retain their selection.

### Steps

To keep the previous behavior, explicitly select the function that used to appear first:

```ts illustrative
draw(gpu, { shader, entry: { vertex: "previous_vertex", fragment: "previous_fragment" } });
compute(gpu, computeSource, { entry: "previous_kernel" });
effect(gpu, fragmentSource, { entry: { fragment: "previous_fragment" } });
```

Only override affected stages. To adopt the new defaults, verify that the conventional entry
accepts the intended vertex inputs and has all the resources it uses bound with `set()`.

Effects still do not expose vertex selection. If an effect module has multiple vertex entries
and previously selected a function other than `vs_main`, rename the unselected `vs_main` entry
to remove the preference, or use `draw()` with explicit vertex and fragment selections. A
fragment-only effect retains its generated fullscreen vertex stage.

### Verification

Compile affected shaders and compare rendered pixels or compute buffer readbacks with the
expected output. Exercise both explicit variants and automatic defaults when modules are
composed in different source orders. Invalid explicit names or names belonging to another
stage must report `VGPU-ENTRY-INVALID` rather than silently selecting a default.
