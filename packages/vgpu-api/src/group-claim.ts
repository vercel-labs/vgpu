import { Draw } from "./draw.ts";

export interface GroupClaim {
  readonly draw: Draw;
  readonly group: number;
  readonly bindGroup: GPUBindGroup;
}

/** Claims a reflected bind group on a Draw. Dynamic offsets still belong to p.draw(draw, { offsets }). */
export function claimGroup(draw: Draw, group: number, bindGroup: GPUBindGroup): GroupClaim {
  draw.layout(group, { dynamicOffsets: true });
  draw.group(group, bindGroup);
  return { draw, group, bindGroup };
}
