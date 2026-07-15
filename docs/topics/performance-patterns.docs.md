# Performance patterns

This is the quick index. Open `performance-playbook` for copy-paste before/after snippets.

## Static scene

Use `gpu.bundle({ target }, recorder)` and replay with `p.bundles(bundle)`.

## First-frame stability

Use `gpu.draw({ shader, mesh, targets: [screenOrTarget] })` so pipeline compilation happens before the transition frame.

## Animated uniforms

Create the pass/draw once and call `.set({ changedValue })`. Do not allocate a new pass or uniform buffer every frame.

## Many objects

Use `instances` when geometry and material are shared. Use `UniformPool` + `draw.group()` + dynamic offsets when each object needs a different uniform block.

## Shared globals

Use one `gpu.uniforms({ time, mouse, camera })` object and bind it into every shader that needs the same struct.

## Iterative effects

Use `gpu.pingPong()` for targets or `gpu.pingPongStorage()` for compute. Do not allocate temporary targets/storage in the loop.

## 3D targets

Create targets with `depth: true` and `msaa: true` when needed; pass those targets through `targets:` at draw creation.
