import { describe, expect, test } from "vitest";
import { formatBinaryLoadError } from "../src/index";

describe("formatBinaryLoadError", () => {
  test("reports glibc workaround for older linux hosts", () => {
    const error = formatBinaryLoadError(new Error("libc.so.6: version `GLIBC_2.38' not found"), {
      detectedGlibcVersion: "2.36",
    });
    expect(error.code).toBe("VGPU-ADAPTER-NODE-BINARY-LOAD");
    expect(error.message).toContain("requires GLIBC 2.38 or newer");
    expect(error.message).toContain("This host reports GLIBC 2.36");
    expect(error.fix).toContain("pnpm test:docker");
    expect(String(error.cause)).toContain("GLIBC_2.38");
  });
});
