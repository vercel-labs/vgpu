import { describe, expect, it, vi } from "vitest";
import {
  main,
  renderHumanReport,
  renderJsonReport,
  runFactoryCli,
} from "../src/cli.ts";
import {
  FactoryConfigurationError,
  FactoryRuntimeError,
} from "../src/errors.ts";
import { makeContext, makeReport } from "./test-helpers.ts";

function outputSink() {
  let value = "";
  return {
    sink: { write: (chunk: string) => (value += chunk) },
    read: () => value,
  };
}

describe("runFactoryCli", () => {
  it("passes a host-only GitHub token to the trusted adapter, not Eve", async () => {
    const context = makeContext();
    const report = makeReport();
    const fetchIssueContext = vi.fn(async () => context);
    const runAgent = vi.fn(async () => report);
    const stdout = outputSink();

    await expect(
      runFactoryCli(["triage", "--issue", "123", "--dry-run", "--json"], {
        appRoot: "/app",
        repositoryRoot: "/repo",
        environment: { GITHUB_TOKEN: "process-token" },
        nodeVersion: "24.1.0",
        buildEnvironment: async () => ({
          credentialKind: "AI_GATEWAY_API_KEY",
          model: "test-model",
          githubToken: "host-only-token",
          environment: {
            AI_GATEWAY_API_KEY: "gateway-token",
            GITHUB_TOKEN: "",
            GH_TOKEN: "",
            VGPU_FACTORY_MODEL: "test-model",
          },
        }),
        fetchIssueContext,
        runAgent,
        stdout: stdout.sink,
      })
    ).resolves.toBe(0);

    expect(fetchIssueContext).toHaveBeenCalledWith(123, {
      token: "host-only-token",
    });
    expect(runAgent).toHaveBeenCalledWith(context, {
      appRoot: "/app",
      environment: {
        AI_GATEWAY_API_KEY: "gateway-token",
        GITHUB_TOKEN: "",
        GH_TOKEN: "",
        VGPU_FACTORY_MODEL: "test-model",
      },
    });
    expect(JSON.parse(stdout.read())).toEqual(report);
  });

  it("loads a fixture without calling GitHub", async () => {
    const context = makeContext();
    const loadFixture = vi.fn(async () => context);
    const fetchIssueContext = vi.fn();
    const stdout = outputSink();
    await runFactoryCli(["triage", "--fixture", "fixture.json", "--dry-run"], {
      appRoot: "/app",
      repositoryRoot: "/repo",
      nodeVersion: "24.0.0",
      buildEnvironment: async () => ({
        credentialKind: "VERCEL_OIDC_TOKEN",
        model: "test-model",
        environment: {
          VERCEL_OIDC_TOKEN: "token",
          VGPU_FACTORY_MODEL: "test-model",
        },
      }),
      loadFixture,
      fetchIssueContext,
      runAgent: async () => makeReport(),
      stdout: stdout.sink,
    });
    expect(loadFixture).toHaveBeenCalledWith("fixture.json", {
      repositoryRoot: "/repo",
    });
    expect(fetchIssueContext).not.toHaveBeenCalled();
    expect(stdout.read()).toContain("DRY RUN");
    expect(stdout.read()).toContain("No GitHub changes were made.");
  });

  it("rejects bad arguments before credentials, GitHub, or Eve are touched", async () => {
    const buildEnvironment = vi.fn();
    await expect(
      runFactoryCli(["triage", "--issue", "123", "--apply"], {
        buildEnvironment,
        nodeVersion: "24.0.0",
      })
    ).rejects.toThrow("Mutation mode");
    expect(buildEnvironment).not.toHaveBeenCalled();
  });
});

describe("main and exit classification", () => {
  it("returns 2 for configuration failures and 1 for runtime failures", async () => {
    const configurationError = outputSink();
    expect(
      await main(["triage", "--issue", "1", "--dry-run"], {
        nodeVersion: "24.0.0",
        buildEnvironment: async () => {
          throw new FactoryConfigurationError("missing credential");
        },
        stderr: configurationError.sink,
      })
    ).toBe(2);
    expect(configurationError.read()).toContain("missing credential");

    const runtimeError = outputSink();
    expect(
      await main(["triage", "--issue", "1", "--dry-run"], {
        nodeVersion: "24.0.0",
        buildEnvironment: async () => ({
          credentialKind: "AI_GATEWAY_API_KEY",
          model: "model",
          environment: { AI_GATEWAY_API_KEY: "key" },
        }),
        fetchIssueContext: async () => {
          throw new FactoryRuntimeError("GitHub failed");
        },
        stderr: runtimeError.sink,
      })
    ).toBe(1);
    expect(runtimeError.read()).toContain("GitHub failed");
  });
});

describe("report renderers", () => {
  it("emits parseable JSON and a readable advisory report", () => {
    const report = makeReport({
      contextWarnings: ["Labels unavailable"],
      missingInformation: ["Minimal reproduction"],
      duplicateOf: {
        number: 100,
        url: "https://github.com/vercel-labs/vgpu/issues/100",
      },
      classification: "duplicate-candidate",
      confidence: "high",
      disposition: "propose-close-duplicate",
      proposedLabels: ["duplicate"],
    });
    expect(JSON.parse(renderJsonReport(report))).toEqual(report);
    const human = renderHumanReport(report);
    expect(human).toContain("Context warnings:");
    expect(human).toContain("Evidence:");
    expect(human).toContain("Candidate duplicate: #100");
    expect(human).toContain("Draft reply:");
  });

  it("neutralizes terminal control characters in human output", () => {
    const report = makeReport({
      summary: "safe\u001b[31mred\nDisposition: forged\u202etext",
    });
    const rendered = renderHumanReport(report);
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain("\u202e");
    expect(rendered).not.toContain("\nDisposition: forged");
    expect(rendered).toContain("\n  Disposition: forged");
  });
});
