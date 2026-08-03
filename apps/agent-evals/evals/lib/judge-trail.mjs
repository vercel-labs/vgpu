/**
 * Multimodal judge for the hover-trail effect, kept as a plain module for the
 * same reason `grade-gradient.mjs` is: an offline probe can call it against
 * two hand-picked PNGs without spending an agent turn, and the eval and the
 * probe grade with the SAME code.
 *
 * Layer note: no eve import here. `autoevals`/`t.judge.autoevals.*` is
 * text-only, so this scorer is built directly on `ai`'s `generateObject` with
 * image content parts instead — already a dependency of `@vgpu/agent-evals`,
 * so this adds no new package.
 */

import { generateObject } from "ai";
import { z } from "zod";

/**
 * Structured verdict shape. Enforced via `generateObject`'s schema so the
 * result is never free text parsing — a judge that "mostly" returns JSON is
 * exactly the failure mode a schema exists to remove.
 */
const RESULT_SCHEMA = z.object({
  score: z.number().min(0).max(100),
  rationale: z.string(),
});

/**
 * The rubric is deliberately explicit about what 100/50/0 each look like:
 * a judge asked only "is there a trail?" collapses to a near-binary score,
 * which throws away exactly the gradation this signal exists to capture.
 */
const RUBRIC = [
  "Two screenshots of the same web page hero section, BEFORE and AFTER the mouse",
  "pointer moved across it through several positions, ending near the pointer's",
  "last position in the AFTER image.",
  "",
  "Score 0-100 how well the AFTER screenshot shows a hover effect that leaves a",
  "fading trail behind recent pointer positions.",
  "",
  "100 = a clear glow/color trail visible in AFTER that fades with distance from",
  "the current pointer position.",
  "50 = something visibly changed near the pointer in AFTER, but it does not read",
  "as a FADING TRAIL specifically (e.g. a hard-edged shape, a single static dot,",
  "or a global change unrelated to pointer position).",
  "0 = the two images look the same, or nothing about the AFTER image reacts to",
  "the pointer at all.",
  "",
  "Answer with a score and a one- or two-sentence rationale explaining what you",
  "actually saw in each image.",
].join("\n");

/**
 * @param {{ beforePng: Buffer, afterPng: Buffer, model: string }} input
 * @returns {Promise<{ score: number, rationale: string }>}
 */
export async function judgeTrailEffect({ beforePng, afterPng, model }) {
  const { object } = await generateObject({
    model,
    schema: RESULT_SCHEMA,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: RUBRIC },
          { type: "text", text: "BEFORE:" },
          { type: "file", data: beforePng, mediaType: "image/png" },
          { type: "text", text: "AFTER:" },
          { type: "file", data: afterPng, mediaType: "image/png" },
        ],
      },
    ],
  });
  return object;
}
