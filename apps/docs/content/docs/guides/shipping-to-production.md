---
title: "Shipping to production: the pre-PR checklist"
description: "Read before opening a PR or calling a render done. Gate correctness, measure, adopt the free performance defaults, and offer (never impose) cheaper alternatives with a number behind each one."
---

A render that looks right on the machine it was written on is halfway done. This guide is the last pass before a PR: it orders the checks that already exist in the other guides and says which ones to apply, which ones to propose, and which ones to skip.

## When to run it

Run it when the work is about to leave the author's hands: a PR is being opened, a branch is being handed over, or the user says the render is done and it will be deployed. Skip it, or shrink it to the correctness gates alone, when the user is prototyping, iterating on a look, or the render is throwaway. A perf review of an experiment slows the experiment without making anything ship faster.

**For agents:** do not start this checklist unprompted in the middle of design work. When you detect the finishing moment (the user asks for a PR, a commit message, a review, or says "done"), say in one line that you are running the pre-PR checks, run the gates, apply the free defaults that verify cleanly, and put everything else in a short proposal with a measurement per item. Never rewrite a working render without a number behind the change.

## 1. Correctness gates (always)

These are cheap and non-negotiable.

- **Validate every WGSL module** the change touches, including imports:

  ```sh
  npx -y vgpu check ./src/shaders/scene.wgsl
  ```

  Fix anything it reports using [Shader diagnostics and fix-its](shader-fix-its.docs.md) before looking at speed.
- **Run the browser tests** if the project has them, or add one for the new render following [Browser testing](browser-testing.docs.md). A render nobody can execute in CI regresses silently.
- **Confirm the frame is deterministic where it claims to be**: `clock(gpu).advance(dt)` for tests and thumbnails, wall clock only in the live loop ([External ticker](external-ticker.docs.md)).
- **Check first-frame behavior**: no `VGPU-*` errors in the console on a fresh load, and every `draw`/`effect` compiles against the target it actually renders into ([Compilation](concepts-compilation.docs.md)).

## 2. Measure before proposing (always)

One measurement per suspected cost, not a general "it feels slow". [Measuring](measuring.docs.md) says which tool answers which question:

| Question | Tool |
| --- | --- |
| Does the first frame hitch? | `performance.now()` around the first `frame()`; compare with and without pre-warm |
| Is CPU encoding the cost? | Time the frame callback; compare a bundled replay |
| Is a pass expensive on the GPU? | `timer(gpu)` spans, one per pass, with `"timestamp-query"` |
| Are bind groups churning? | Count `set()` calls with new resource identities per frame |

Write the numbers down. They are the justification for every item in sections 3 and 4, and they go in the PR description.

## 3. Free defaults (apply when verified)

These change no pixels and are mechanical to verify, so apply them when the render matches the pattern and re-run section 1 afterwards. Each one is a Before/After in the [Performance playbook](performance-playbook.docs.md).

- **Pre-warm pipelines** with `await draw.compile(target)` for every target signature hit before the first visible frame.
- **Bundle static draws** and replay them with `p.bundles(...)`; re-record only when a sampled resource identity changes.
- **Share globals** through `uniforms(gpu)` instead of setting the same values on every draw.
- **Instance repeated geometry** instead of looping draws.
- **Skip work that did not change**: demand rendering for static scenes, a capped `fps` for ambient loops ([Frames](concepts-frames.docs.md)).
- **Keep heavy or optional dependencies out of the initial chunk**: dynamic `import()` after the first presented frame, as [Adaptive quality](adaptive-quality.docs.md) does for detect-gpu.

If applying one of these needs a structural change the author did not ask for (claiming bind groups, moving to ping-pong storage, splitting passes), it belongs in section 4 instead.

## 4. Cheaper alternatives (propose, never impose)

These trade something visible or structural for speed. List them in the PR or in the handover with the measurement from section 2 next to each, and let the human choose.

- **Smaller target formats**: `rgba16float` where `rgba32float` is not needed, `r16float` for scalar fields ([Texture-format matrix](texture-formats.docs.md)).
- **Lower internal resolution** for post-processing chains: bloom, blur, and SSAO rarely need full resolution.
- **Fewer passes or iterations**: merge a two-pass blur into one when the radius allows, cap iterative solvers.
- **A Low tier** when the render is continuous and always visible (hero, ambient background) and the audience includes phones or laptops on battery. The full pattern is in [Adaptive quality](adaptive-quality.docs.md) with its example; the smallest step is a frame-health monitor plus a DPR drop.
- **A static fallback** (poster image, CSS gradient) for `VGPU-RING1-UNSUPPORTED`, when WebGPU itself is unavailable.

Phrase each item as a one-line trade: "bloom at half resolution saves 1.8 ms of a 6.1 ms frame on this GPU; the halo softens slightly." A proposal without a number is an opinion.

## 5. Hand it over

Before opening the PR:

- The PR description lists the measurements from section 2, the defaults applied from section 3, and the alternatives offered from section 4, in that order.
- Thumbnails, snapshots, or screenshots were regenerated if the render changed ([WebGPU screenshots with agent-browser](agent-browser-webgpu.docs.md)).
- Anything skipped from this checklist is named, with the reason.

## See also

- [Performance model](performance-model.docs.md): why the defaults in section 3 are free.
- [Optimize a pass](optimize-pass.docs.md): the per-pass procedure once a measurement points at one.
- [Authoring shaders for performance](authoring-for-perf.docs.md): WGSL and JavaScript defaults that keep layouts stable.
