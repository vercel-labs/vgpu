# DOCS-TEMPLATE — standard format for code-symbol `.docs.md` files

Primary audience: **LLM agents** that read these docs through the CLI bundled with their installed
`vgpu` package and copy examples literally.
Guiding principle: **anti-assumption** — explicit defaults, valid values, and expected errors.
Anti-drift: option A — tables are hand-written and the **review gate checks each row against the real types in `src`**. There is no automatic lint for table correctness yet.

This file is committed in the repo as `docs/DOCS-TEMPLATE.md` for future contributors.

## Required structure for code-symbol docs

```markdown
# <exact symbol>                          ← example: createRenderBundle

<1–2 lines: what it is and WHEN to use it.>

## Import

\```ts
import { <symbol> } from "<exact entrypoint>";   ← vgpu | vgpu/node | vgpu/mock | vgpu/scene | vgpu/core | @vgpu/render/<subpath>
\```

## Signature

\```ts
<real typed signature, copied from or derived from src>
\```

## Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| device | Device | ✔ | — | ... |
| options.colorFormats | GPUTextureFormat[] | ✔ | — | valid values / restrictions |
| options.sampleCount | number | ✖ | 1 | what happens when omitted |

Nested options objects: use one row per field with `options.field` notation. If there are two or more nesting levels, use one table per level.

**Returns:** <type> — what callers can do with it.
**Throws:** <code VGPU-*> when <condition> — <how to fix it>. Omit only if the symbol cannot throw.

## Examples

\```ts
<minimal copy-paste example that COMPILES against the workspace>
\```

Add a realistic example when the symbol has distinct usage modes.

## Notes

- Gotchas, performance implications, explicit anti-patterns ("Do not do X; do Y instead").
- **See also:** <related symbols> — so agents do not reimplement what already exists.
```

## Rules

1. **Import first, exact entrypoint.** There are multiple entrypoints; the most common LLM error is importing from the wrong one.
2. **Do not use ring jargon in public docs — refer to entrypoints and layers instead.** Prefer "the main API (`vgpu`)", "the core layer (`vgpu/core`)", and "scene helpers (`vgpu/scene`)".
3. **Signature anchors shape; the table anchors semantics.** Both are required for functions, factories, and methods. For pure types (interfaces/type aliases), the table describes fields.
4. **Default column is never empty:** use `—` only for required fields. If a field is optional, state the real default and the behavior when omitted.
5. **Returns and Throws are required** for every callable. Cite `VGPU-*` codes with their condition and fix.
6. **Every snippet compiles** — this is checked mechanically with the extractor plus `tsc`.
7. **See also** goes at the end: at least one cross-link except for leaf symbols.
8. Topic guides (`docs/topics/*.docs.md`) do not use this template; they are narrative guides.
9. API and guide docs ship in the `vgpu` package; they are not copied into the repository skill.
   `skills/vgpu/SKILL.md` is a generated, version-neutral router. Edit co-located `.docs.md` files
   for documentation changes, or `packages/vgpu/lib/docs/generate/skill.js` for router changes,
   then regenerate.

## Docs change process

1. Edit the co-located `.docs.md` next to the source.
2. Run `pnpm -F @vgpu/cli generate:docs`.
3. Commit source docs and generated CLI/site artifacts together; CI `docs-generated` requires them
   and the generated thin skill router to stay in sync with their respective sources.
