import { expect, test } from "vitest";

import { deterministicDustTime } from "./path";

test("advances the deterministic dust clock by one production tick", () => {
  expect(deterministicDustTime(0)).toBe(0);
  expect(deterministicDustTime(1)).toBe(1 / 30);
  expect(deterministicDustTime(2)).toBe(2 / 30);
  expect(deterministicDustTime(121)).toBe(121 / 30);
});
