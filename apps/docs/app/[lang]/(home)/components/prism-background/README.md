# Prism background architecture

The production reading path is intentionally short:

1. `prism-background.tsx` mounts the canvas and connects theme/debug UI.
2. `renderer.ts` owns the GPU, frame loop, interaction, and presentation budget.
3. `pipeline-controller.ts` lazily loads the selected theme and quality tier.
4. `pipelines/light/index.ts` or `pipelines/dark/index.ts` owns that pipeline's lifecycle.
5. Within a pipeline:
   - `create-graph.ts` declares its draws, effects, shaders, and samplers.
   - `bind.ts` supplies uniforms, textures, and other bindings.
   - `render.ts` is the authoritative render-pass order.
   - `targets.ts` owns render-target allocation and resizing.

## Directory map

```text
prism-background/
├── prism-background.tsx       React entry
├── renderer.ts                browser renderer and frame loop
├── pipeline-controller.ts     lazy theme/quality dispatch
├── thumbnail.ts               headless thumbnail entry
├── scene/                     camera, optics, framing, and geometry
├── environment/               shared environment resources and shaders
├── pipelines/
│   ├── light/                 light-theme pipeline
│   │   ├── assets/            baked wall and caustic assets
│   │   ├── debug/             light-only preview draws
│   │   └── passes/            wall, shadow, caustic, and presentation
│   ├── dark/                  dark-theme pipeline
│   │   └── passes/            light, bloom, particles, wall, presentation
│   └── shared/                glass, spectral, wireframe, presentation
├── runtime/                   mutable GPU/runtime state and resources
├── debug/                     opt-in graph UI and GPU preview host
└── performance/               opt-in deterministic performance sampling
```

## Ownership rules

- Pass-specific TypeScript and WGSL stay together under that pass.
- A resource used by both themes belongs in `pipelines/shared/`.
- Scene math and mesh generation do not depend on a render pipeline.
- Environment generation is shared runtime infrastructure, not a pipeline pass.
- Tests live beside the implementation they cover.
- Import implementation files directly. The light and dark `index.ts` files are
  the only intentional pipeline boundaries.

## Loading boundaries

Do not statically import light or dark pipeline implementation from the React
entry or renderer. `pipeline-controller.ts` dynamically loads only the active
theme. Debug graph code, debug GPU previews, performance sampling, and thumbnail
rendering are also intentionally loaded only when requested.
