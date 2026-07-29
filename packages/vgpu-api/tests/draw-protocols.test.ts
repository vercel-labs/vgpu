import { expect, test, vi } from "vitest";
import { BINDING_RESOURCE, bindingResourceOf } from "../src/draw-protocols.ts";

test("bindingResourceOf only accepts callable nominal providers", () => {
  expect(bindingResourceOf({ [BINDING_RESOURCE]: 1 })).toBeUndefined();
  const method = vi.fn();
  const provider = { [BINDING_RESOURCE]: method };
  expect(bindingResourceOf(provider)).toBe(provider);
});
