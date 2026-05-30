# @vgpu/site

Standalone VGPU landing page app.

## Commands

```bash
pnpm --filter @vgpu/site dev
pnpm --filter @vgpu/site typecheck
pnpm --filter @vgpu/site build
pnpm --filter @vgpu/site storybook
pnpm --filter @vgpu/site build-storybook
pnpm --filter @vgpu/site artifacts
```

## Visual artifacts

Playwright writes deterministic review PNGs to:

- `artifacts/vgpu-site/landing-desktop.png`
- `artifacts/vgpu-site/landing-mobile.png`

See `docs/agent-visual-review.md` for design tokens, review protocol, and rules for future agents.
