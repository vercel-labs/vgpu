import { describe, expect, test } from "vitest";
import { glibcMismatch } from "../src/dawn-loader";

describe("glibcMismatch", () => {
  test("extracts the binary requirement and host runtime", () => {
    expect(glibcMismatch(new Error("libc.so.6: version `GLIBC_2.38' not found"), "2.36")).toEqual({
      required: "2.38",
      host: "2.36",
    });
  });
});
