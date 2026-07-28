import { VGPUError } from "../../errors.ts";

export function sceneCycleError(where: string, label: string | undefined): VGPUError {
  const name = label ? `'${label}'` : "the node";
  return new VGPUError({
    code: "VGPU-SCENE-CYCLE",
    message: `add() would make ${name} an ancestor of itself.`,
    fix: "Remove the node from the ancestor chain first, or add a different node.",
    where,
  });
}

export function sceneValueError(where: string, name: string, expected: string): VGPUError {
  return new VGPUError({
    code: "VGPU-SCENE-VALUE-INVALID",
    message: `\`${name}\` is invalid; expected ${expected}.`,
    fix: `Pass ${expected} for \`${name}\`.`,
    where,
  });
}
