// House style for vgpu documentation, distilled from the polished concept guides
// (docs/topics/concepts-*.docs.md) so the writer does not have to re-derive it every session.

export const docsStyleGuide = `
# vgpu docs style

The primary reader is an AI agent that copies examples literally; the second reader is a developer skimming. Write so both get the correct call on the first try.

## Voice
- Second person, present tense, active voice: "Open a pass by hand when you want to composite multiple draws".
- State facts and rules plainly. No marketing ("powerful", "seamless", "easily"), no "we", no "please", no filler intros ("In this guide we will...").
- Precise over vague: name the exact call, default, error code, and number. "fires the callback once immediately with the current size, then again on every resize".
- Scope guarantees explicitly and say what is NOT covered: "The guarantee is scoped to the command buffer. The frame clock has already ticked, ..."
- Explain why a rule exists in one clause: "vgpu throws VGPU-FRAME-REENTRANT so command encoders stay ordered and predictable."
- Em dashes are fine for asides. Keep paragraphs to 1–4 sentences.

## Structure of a guide (docs/topics/*.docs.md)
- Frontmatter: title, summary, relatedSymbols, prevNext, order (copy the shape of a neighbouring guide).
- summary: one sentence that names the call and its job, optionally two clauses joined by a semicolon: "frame(gpu, cb) encodes your passes and submits once; frameLoop(gpu, cb) drives animation."
- H1 equals title. The opening paragraph defines the concept in 2–3 sentences and says when to use it; the first code example follows almost immediately.
- H2 headings are sentence case and task- or situation-oriented: "Render a single frame", "When the callback throws", "Create resources once, draw every frame", "One shader? Draw it directly", "Updating bindings".
- Build incrementally: each section changes one thing from the previous example and says what changed ("The pass is the same — the only change is its target").
- When a helper replaces manual work, show the manual version too, then say what the helper does for you: "Both work. frameLoop(gpu) is the same loop with the clock, throttling, and resize handling done for you."
- Give the decision rule for alternatives: "Reach for textureLoad only when you need exact texels or an unfilterable format — for ordinary sampling, a filtering sampler is simpler and faster."
- End with a live example link when one exists: "See it live: the [fluid example](/examples/fluid) runs ..."

## Links and identifiers
- Link a symbol to its reference page on first mention: [\`frame(gpu)\`](/reference/vgpu/frame#framerunner), [\`Target\`](/reference/vgpu/target#target). Link other guides as [Compilation](/concepts/compilation).
- All identifiers, option names, error codes, and file names in backticks. Refer to layers by entrypoint ("the core layer (\`vgpu/core\`)"), never by internal jargon.

## Callouts
- "> Good to know: ..." for useful, non-obvious capability or context.
- "> Warning: ..." for mistakes that break things; name the error code and the correct alternative.
- Use at most one or two per section.

## Code examples
- Every snippet is TypeScript that compiles against the workspace (checked by \`pnpm docs:verify-snippets\`). Import from the exact entrypoint.
- Put required setup above a \`// ---cut---\` line; readers only see what follows it. Keep the visible part focused on the concept.
- Descriptive names: canvasSurface, sceneTarget, pulseEffect, postprocessing — never foo/bar/x.
- Short trailing comments explain intent, not syntax: "// the offscreen result becomes the post input", "// call it when your component unmounts".
- Follow each snippet with 1–2 sentences on what happened or the rule it demonstrates.
- WGSL inside template strings uses fs_main / vs_main and realistic but tiny shaders.
- Never hardcode a canvas format: use \`navigator.gpu.getPreferredCanvasFormat()\` or \`canvasSurface.format\`. Multi-pass and surface rendering goes through \`frame(gpu)\` / \`frameLoop(gpu)\`.
- Partial or historical snippets that should not compile use a \`ts illustrative\` fence; everything else is plain \`ts\`.

## Symbol docs (co-located *.docs.md)
Follow docs/DOCS-TEMPLATE.md exactly: # symbol, 1–2 line purpose + when to use, ## Import, ## Signature, ## Parameters table (Default column never empty; "—" only for required), **Returns:**, **Throws:** bullets "VGPU-CODE when <condition> — <fix>", ## Examples (minimal, compiling), ## Notes with anti-patterns and **See also:**.

## Example: guide section (from concepts-passes)

# Passes

A pass is a render-pass section inside a frame. It has one target, one clear color, and any number of draw calls. Open a pass by hand when you want to composite multiple draws into the same render target — here, an ocean and a boat rendered straight to the canvas:

\`\`\`ts
import { init, effect, frame, surface } from "vgpu";

const gpu = await init();
const canvas = document.querySelector("canvas")!;
const canvasSurface = surface(gpu, canvas);
const oceanSource = \`...\`;
const boatSource = \`...\`;

// ---cut---
const ocean = effect(gpu, oceanSource);
const boat = effect(gpu, boatSource);

frame(gpu, (currentFrame) => {
  currentFrame.pass({ target: canvasSurface, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(ocean); // fill the canvas with water
    pass.draw(boat); // paint the boat on top — same target
  });
});
\`\`\`

Both draws share one render pass and one target. Order inside the pass is paint order: the ocean fills the canvas first, then the boat draws on top of it.

> Good to know: [\`FramePass.draw()\`](/reference/vgpu/frame#framepass) accepts a fullscreen [\`Effect\`](/reference/vgpu/effect#effect) or an explicit [\`Draw\`](/reference/vgpu/draw#draw). Use \`draw(gpu)\` when you need meshes, vertex counts, instancing, or raw bind groups.

## Example: failure semantics (from concepts-frames)

## When the callback throws

The callback is all-or-nothing for the frame's command buffer. If it returns, the frame submits once. If it throws, vgpu cancels the frame: nothing it encoded reaches the GPU, the timer and visibility instances it attached release their per-frame retains, and the error reaches you unchanged. A half-encoded frame is never presented by accident.

> Warning: Do not call \`frame(gpu)\` from inside another frame callback or from a surface resize callback. vgpu throws \`VGPU-FRAME-REENTRANT\` so command encoders stay ordered and predictable.

## Example: performance rule (from concepts-effects)

\`set()\` writes immediately — there is no change detection, so every call is a real GPU write. Match your calls to how often values actually change: constants once at creation, size- and resolution-class uniforms at init and on resize, and per-frame calls only for genuinely dynamic values like time or pointer input. Rebinding the same resources is free — bind groups are cached by resource identity — so this rule is purely about avoiding redundant writes.

## Example: Throws bullets (from timer.docs.md)

- \`VGPU-TIMER-INVALID\` when \`timer(gpu)\` runs on a device without \`"timestamp-query"\` — request it: \`init({ requiredFeatures: ["timestamp-query"] })\`.
- \`VGPU-TIMER-CAPACITY\` when one frame times more than 2048 spans; a timer owns one timestamp query set and WebGPU \`createQuerySet\` caps \`count\` at 4096 (2 queries per span) — time fewer passes, or spread timing across frames.
`.trim();
