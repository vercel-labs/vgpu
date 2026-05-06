import { describe, expect, test } from "vitest";
import { xxh64 } from "../src/runtime/xxh64.ts";

describe("xxh64", () => {
  test("matches reference vectors", () => {
    expect(xxh64("")).toBe("ef46db3751d8e999");
    expect(xxh64("abc")).toBe("44bc2cf5ad770999");
    expect(xxh64("hello")).toBe("26c7827d889f6da3");
    expect(xxh64("The quick brown fox jumps over the lazy dog")).toBe("0b242d361fda71bc");
    expect(xxh64("1234567890123456789012345678901234567890")).toBe("5f3af5e23eeb431d");
  });
});
