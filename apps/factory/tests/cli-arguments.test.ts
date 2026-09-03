import { describe, expect, it } from "vitest";
import {
  assertSupportedNodeVersion,
  parseFactoryArguments,
} from "../src/cli-arguments.ts";
import { FactoryConfigurationError, FactoryUsageError } from "../src/errors.ts";

describe("parseFactoryArguments", () => {
  it("parses issue and fixture dry runs", () => {
    expect(
      parseFactoryArguments(["triage", "--issue", "42", "--dry-run"])
    ).toEqual({
      command: "triage",
      dryRun: true,
      issueNumber: 42,
      json: false,
    });
    expect(
      parseFactoryArguments([
        "triage",
        "--fixture",
        "apps/factory/evals/fixtures/bug.json",
        "--dry-run",
        "--json",
      ])
    ).toEqual({
      command: "triage",
      dryRun: true,
      fixturePath: "apps/factory/evals/fixtures/bug.json",
      json: true,
    });
  });

  const invalidArguments: readonly (readonly string[])[] = [
    [],
    ["other"],
    ["triage", "--issue", "0", "--dry-run"],
    ["triage", "--issue", "1.5", "--dry-run"],
    ["triage", "--issue", "1"],
    ["triage", "--dry-run"],
    ["triage", "--issue", "1", "--fixture", "x.json", "--dry-run"],
    ["triage", "--issue", "1", "--dry-run", "--dry-run"],
    ["triage", "--issue", "1", "--dry-run", "--json", "--json"],
    ["triage", "--issue", "1", "--dry-run", "--apply"],
    ["triage", "--issue", "1", "--dry-run", "--repo", "vercel-labs/vgpu"],
    ["triage", "--issue", "1", "--dry-run", "--wat"],
  ];

  it.each(invalidArguments.map((argv) => [argv] as const))(
    "rejects unsafe or malformed arguments: %j",
    (argv) => {
      expect(() => parseFactoryArguments(argv)).toThrow(FactoryUsageError);
    }
  );
});

describe("assertSupportedNodeVersion", () => {
  it("accepts Node 24 and later", () => {
    expect(() => assertSupportedNodeVersion("24.0.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("25.1.2")).not.toThrow();
  });

  it.each(["23.11.0", "not-a-version", ""])(
    'rejects unsupported version "%s"',
    (version) => {
      expect(() => assertSupportedNodeVersion(version)).toThrow(
        FactoryConfigurationError
      );
    }
  );
});
