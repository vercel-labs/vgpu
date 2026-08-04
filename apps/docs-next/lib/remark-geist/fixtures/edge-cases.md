---
title: Edge case fixture
description: Adversarial shapes the M1-M9 plugins must survive without touching text.
---

## A fence with a label that is not a language at all

```384:401:packages/wgsl/src/runtime/resolve-shader.ts
export function resolveShader(entry: string, options?: ResolveShaderOptions) {
  // eve hit exactly this shape: a line range plus a file path where Shiki
  // expects a language identifier.
}
```

## A fence with no info string (744 occurrences — must stay unhighlighted)

```
VGPU-WGSL-ENTRY-NOT-FOUND: no entry point named "main" in shader.wgsl
```

## A fence whose body looks like markdown links

```text
See [frames](concepts-frames.docs.md) and /reference/vgpu/frame#framepass —
neither of these is a link node, so neither may be rewritten.
```

## Inline code that looks like a link

Run `npx vgpu docs cat /@vgpu/wgsl-std/noise/perlin/index.docs.md` to read it in
the terminal, or use the [rendered page](/@vgpu/wgsl-std/noise/perlin/index.docs.md).
The command must stay verbatim; only the second href is rewritten.

## A blockquote nested inside a recognized one

> Good to know: nesting is legal markdown and the outer quote is still an info Callout.
>
> > Warning: the inner quote is rewritten first, so the outer Callout carries it as a child.

## A blockquote whose prefix is not at the very start of a paragraph

> This paragraph mentions Good to know: in the middle, which is not an admonition.

## A blockquote with a bold prefix

> **Warning:** the flattened text still starts with the literal prefix, so this maps to warn.

## Links that must not gain a `/docs` prefix

- [protocol-relative](//example.com/x)
- [already prefixed](/docs/reference/vgpu/frame#framepass)
- [examples subtree](/examples/air-painting)
- [not the examples subtree](/examples-archive/old)
- [api route](/api/examples/v1/latest.json)

## Tables (M11 — never mapped, GFM styles them natively)

| Parameter | Type | Description |
| --- | --- | --- |
| `entry` | `string` | Path to the WGSL entry module. |
| `options` | `{ rootDir?: string }` | Resolution options. |

**Returns:** a `ShaderSource` (M12 — deliberately not mapped in phase 1).
