# VGPU Site Agent Guide

This app is a standalone Next 15 landing page at `apps/vgpu-site`. Keep all site work inside this app and do not touch the abandoned dirty `front` worktree.

## Stack

- Next 15 App Router with Turbopack.
- React 18.
- Tailwind CSS v4.
- `tw-blocks` v4 is compatible and used through CSS imports: `@import "tailwindcss"; @import "tw-blocks";`.
- App-local Storybook uses `@storybook/react-vite`; `@storybook/nextjs` 8 hit a Next 15 webpack-builder failure during validation.
- Uses the public `geist` package for Geist Sans, Geist Mono, and Geist Pixel Square font variables.
- No private `@vercel/*` packages.

## Design tokens and rules

Tokens live in `app/globals.css`:

- `--background`: near-black page surface.
- `--foreground`: high-contrast white text.
- `--muted`: card/panel surface.
- `--muted-foreground`: secondary copy.
- `--accent`: sparse white accent.
- `--border`: crisp low-contrast borders.
- `--radius`: default rounded panel radius.
- `--font-sans` / `--font-mono`: Geist Sans and Geist Mono, with system fallbacks.
- `--font-pixel`: Geist Pixel Square for small decorative footer lettering.

Rules:

1. Monochrome first; use gradients only as depth, not decoration.
2. Prefer borders, spacing, and type hierarchy over color.
3. Use `tw-blocks` utilities for layout rhythm: `tab-*` for fine spacing and `block-*` for structural sizes.
4. Keep components server-renderable unless browser state is required.
5. Keep all GPU output represented by static/code/headless artifacts; do not require live WebGPU for screenshots.
6. The hero pixel `vgpu` treatment is an original static 7x7 coordinate map for the letters v/g/p/u, rendered with CSS spans. It is inspired by bitmap sampling workflows and Geist Pixel style but does not copy generated coordinates or code from external repositories.
7. The accessible hero message remains real text in Geist Mono; decorative pixel/shader treatments must be `aria-hidden`.

## Storybook commands

From the repo root:

```bash
pnpm --filter @vgpu/site storybook
pnpm --filter @vgpu/site build-storybook
```

Stories are in `apps/vgpu-site/stories/landing.stories.tsx` and expose the full page plus each major section.

If Storybook is not running, use the app-local preview route:

```bash
pnpm --filter @vgpu/site dev
open http://127.0.0.1:3000/preview
```

## PNG visual artifact commands

Generate stable desktop and mobile PNGs:

```bash
pnpm --filter @vgpu/site artifacts
```

Artifacts are written to stable paths:

- `apps/vgpu-site/artifacts/vgpu-site/landing-desktop.png`
- `apps/vgpu-site/artifacts/vgpu-site/landing-mobile.png`

The Playwright config starts the local Next dev server on port `3100` and captures the landing page with animations disabled.

## VGPU Docker shader validation

The browser site stays static and does not require live WebGPU. The decorative hero/footer pixel treatment is mirrored by a deterministic WGSL snapshot test in the repository render package:

- Test: `packages/render/tests/poc/site-ascii-shader.test.ts`
- Snapshot artifact: `packages/render/tests/poc/__snapshots__/site-ascii-shader.png`

Use the pinned Docker path so the Dawn/WebGPU native adapter runs in the repo-standard Node 22 + Debian trixie + Mesa/Xvfb environment:

```bash
VGPU_WRITE_SNAPSHOTS=1 pnpm test:docker # write/update snapshots through the repo-standard full Docker suite
pnpm test:docker                        # validate snapshots through the repo-standard full Docker suite
pnpm test:docker:cleanup                # optional cleanup
```

For a targeted site-only shader check after the image has been built, use the same Docker image and mounted snapshot directory:

```bash
docker run --rm --label vgpu-test=1 \
  -v "$PWD/packages/render/tests/poc/__snapshots__:/workspace/packages/render/tests/poc/__snapshots__" \
  vgpu-test:s2 \
  sh -lc 'Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 & xvfb_pid=$!; VGPU_DOCKER_TEST=1 pnpm exec vitest run packages/render/tests/poc/site-ascii-shader.test.ts; status=$?; kill $xvfb_pid; exit $status'
```

The test freezes viewport, shader inputs, and lettering coordinates; it does not depend on browser WebGPU or Playwright screenshots.

## Visual review protocol

1. Generate artifacts with `pnpm --filter @vgpu/site artifacts`.
2. Open both PNGs.
3. Check desktop and mobile for:
   - readable hero and CTA hierarchy,
   - no horizontal overflow,
   - clear code comparison panels,
   - feature cards with enough contrast,
   - footer and CTA visible at the end of the page.
4. If layout changes, regenerate PNGs and re-review before reporting.

## Performance and accessibility rules

- Keep the page static and server-rendered.
- Avoid heavy client-side JavaScript and animation libraries.
- Use semantic landmarks (`header`, `main`, `section`, `footer`) and descriptive link text.
- Preserve visible focus states from browser defaults or add explicit high-contrast focus styles when introducing custom controls.
- Maintain high color contrast for text and controls.
- Do not import live WebGPU modules into landing sections unless there is a static fallback for artifact generation.

## What not to do

- Do not touch `front` or any non-VGPU repository.
- Do not add private packages.
- Do not depend on a package named `@vgpu/wgsl-std`; this checkout does not expose one. Mention WGSL std utilities textually unless a package export exists later.
- Do not make Playwright screenshots depend on GPU availability.
- Do not commit transient `.next`, Storybook build output, or Playwright report directories.
