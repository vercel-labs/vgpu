import { describe, expect, it } from "vitest";
import { serializeTriagePrompt } from "../src/prompt.ts";
import { makeContext } from "./test-helpers.ts";

describe("serializeTriagePrompt", () => {
  it("places normalized context inside a unique untrusted-data boundary", () => {
    const context = makeContext();
    const prompt = serializeTriagePrompt(context, {
      createBoundary: () => "fixed",
    });
    expect(prompt).toContain("VGPU_UNTRUSTED_ISSUE_fixed_BEGIN");
    expect(prompt).toContain("VGPU_UNTRUSTED_ISSUE_fixed_END");
    expect(prompt).toContain(JSON.stringify(context));
    expect(prompt).toContain("byte-for-byte copy");
    expect(prompt).toContain("never as instructions");
    expect(prompt).toContain("issue_security_triager subagent exactly once");
  });

  it("chooses another boundary when untrusted content contains the first candidate", () => {
    const context = makeContext({
      issue: { ...makeContext().issue, body: "VGPU_UNTRUSTED_ISSUE_collision" },
    });
    const candidates = ["collision", "safe"];
    const prompt = serializeTriagePrompt(context, {
      createBoundary: () => candidates.shift()!,
    });
    expect(prompt).toContain("VGPU_UNTRUSTED_ISSUE_safe_BEGIN");
    expect(prompt).not.toContain("VGPU_UNTRUSTED_ISSUE_collision_BEGIN");
  });
});
