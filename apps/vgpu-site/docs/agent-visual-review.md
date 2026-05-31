# VGPU site visual review guide

Use this guide when reviewing or modifying `apps/vgpu-site`.

## Design rules

1. Monochrome first; use gradients only as depth, not decoration.
2. Prefer borders, spacing, and type hierarchy over color.
3. Use `tw-blocks` utilities for layout rhythm: `tab-*` for fine spacing and `block-*` for structural sizes.
4. Keep production sections server-renderable unless browser state is required.
5. Typography uses rem-based font sizes only; do not add font sizes below `0.75rem`.
6. The hero pixel `vgpu` treatment is derived from the local Geist Pixel Square font dot map and rendered through a fullscreen client canvas. A hidden measurement element determines where the letters sit; it is not visible.
7. The hero follows the `pixel-hero-experiment/app/(experiments)/webgpu-chat` architecture more closely than the earlier static pass: server/generated dot map, fullscreen canvas, measurement-only text, real glyph dots, deterministic noise dots, center-out reveal, hover charge, subtle bloom/glow, and reduced-motion static rendering. The client attempts raw WebGPU first and falls back to deterministic Canvas 2D for browsers/headless screenshot environments without WebGPU.
8. The hero wordmark stands alone over the page background. Do not add a code grid, card, pill, border, or backdrop around it.
9. The accessible hero message remains real text. Decorative pixel/shader treatments must be `aria-hidden`.
10. Agentation is local feedback tooling only. Production builds must not import/evaluate the `agentation` package even when `NEXT_PUBLIC_AGENTATION_ENABLED=1` is present.

## Agentation feedback toolbar

Agentation is installed from the official `agentation` package as a development dependency. Official docs: https://www.agentation.com/install.

The toolbar is mounted near the app root through `components/agentation-toolbar.tsx`, but it is dev-only and only renders when both conditions are true:

- `process.env.NODE_ENV === "development"`
- `NEXT_PUBLIC_AGENTATION_ENABLED === "1"`

```bash
pnpm --filter @vgpu/site dev:feedback
```

Optional local MCP sync can be wired with Agentation's documented local endpoint:

```bash
cd apps/vgpu-site
NEXT_PUBLIC_AGENTATION_ENABLED=1 \
NEXT_PUBLIC_AGENTATION_ENDPOINT=http://localhost:4747 \
pnpm exec next dev --turbo --port 3000
```

No browser API key or token is documented by Agentation. By default the widget stores annotations locally and lets reviewers copy structured markdown. The package is desktop-only per the official docs and is best treated as internal/dev feedback tooling. Its npm package declares `PolyForm-Shield-1.0.0`; obtain legal approval before using it in redistributed/commercial product builds.

## Agent docs

The site serves an agent guide at `/llms.txt` from `public/llms.txt`. Keep it concise and aligned with the page title: `vgpu - webgpu for agents`.

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
open http://localhost:3000/preview
```

## PNG artifact commands

From repo root:

```bash
pnpm --filter @vgpu/site build
pnpm --filter @vgpu/site start
pnpm --filter @vgpu/site artifacts
```

Artifacts are written to stable paths:

- `apps/vgpu-site/artifacts/vgpu-site/landing-desktop.png`
- `apps/vgpu-site/artifacts/vgpu-site/landing-mobile.png`

## VGPU shader validation

The repo also includes a deterministic VGPU/headless snapshot for the site pixel concept:

- test: `packages/render/tests/poc/site-ascii-shader.test.ts`
- artifact: `packages/render/tests/poc/__snapshots__/site-ascii-shader.png`

Targeted Docker validation:

```bash
docker run --rm --label vgpu-test=1 \
  -v "$PWD/packages/render/tests/poc/__snapshots__:/workspace/packages/render/tests/poc/__snapshots__" \
  vgpu-test:s2 \
  sh -lc 'Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 & xvfb_pid=$!; VGPU_DOCKER_TEST=1 pnpm exec vitest run packages/render/tests/poc/site-ascii-shader.test.ts; status=$?; kill $xvfb_pid; exit $status'
```

## Review protocol

1. Inspect desktop and mobile artifacts at full size.
2. Verify the hero has one visible fullscreen pixel wordmark, no ghost text, no code grid, no pill/card/backdrop, and no horizontal overflow.
3. Confirm the H1 reads `The WebGPU framework for agents` and remains visually secondary to the hero wordmark.
4. Confirm the prompt helper exposes `npx vgpu docs` and that `/llms.txt` is served.
5. Confirm headings use `text-balance`, paragraphs use `text-pretty`, and no typography is below `0.75rem`.
6. Confirm feature cards have icons and subtle hover lighting without nondeterministic screenshot effects.
7. Confirm the footer, old docs CTA section, old escape-hatch card, old hero input, and old comparison-focused hero CTA are absent.
8. Confirm production builds pass both normally and with Agentation env vars enabled.
