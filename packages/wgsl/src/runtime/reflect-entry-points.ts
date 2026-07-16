import type { Attr } from "./reflect-types.ts";
import { splitGeneric } from "./reflect-utils.ts";

export function parseWorkgroupSize(attrs: readonly Attr[]): readonly [number, number, number] | undefined {
  const attr = attrs.find((item) => item.name === "workgroup_size");
  if (!attr) return undefined;
  const values = splitGeneric(attr.args).map((part) => Number(part.map((token) => token.text).join("")));
  return [values[0] ?? 1, values[1] ?? 1, values[2] ?? 1];
}
