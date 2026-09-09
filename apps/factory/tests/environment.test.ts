import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSanitizedEveEnvironment,
  type EnvironmentFileReader,
} from "../src/environment.ts";
import { FactoryConfigurationError } from "../src/errors.ts";

function envReader(files: Record<string, string>): EnvironmentFileReader {
  return vi.fn(async (path) => {
    const source = files[basename(path)];
    if (source === undefined) {
      const error = new Error("not found") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return source;
  });
}

describe("buildSanitizedEveEnvironment", () => {
  it("forwards only a small OS allowlist, one Gateway credential, and the model", async () => {
    const result = await buildSanitizedEveEnvironment({
      appRoot: "/app",
      hostEnvironment: {
        PATH: "/bin",
        HOME: "/home/test",
        AI_GATEWAY_API_KEY: "gateway-secret",
        VERCEL_OIDC_TOKEN: "oidc-must-not-be-forwarded",
        VGPU_FACTORY_MODEL: "openai/test-model",
        GITHUB_TOKEN: "github-secret",
        AWS_SECRET_ACCESS_KEY: "aws-secret",
        EVE_TRACES_CONTENT: "on",
        NODE_OPTIONS: "--require malicious.js",
      },
      readEnvironmentFile: envReader({}),
    });

    expect(result.credentialKind).toBe("AI_GATEWAY_API_KEY");
    expect(result.model).toBe("openai/test-model");
    expect(result.environment).toMatchObject({
      PATH: "/bin",
      HOME: "/home/test",
      AI_GATEWAY_API_KEY: "gateway-secret",
      VERCEL_OIDC_TOKEN: "",
      VGPU_FACTORY_MODEL: "openai/test-model",
      GITHUB_TOKEN: "",
      GH_TOKEN: "",
      EVE_TRACES_CONTENT: "off",
      NODE_ENV: "development",
      NO_COLOR: "1",
    });
    expect(result.environment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.environment.NODE_OPTIONS).toBeUndefined();
    expect(result.githubToken).toBe("github-secret");
  });

  it("blocks every non-allowlisted env-file key from Eve's dotenv reload", async () => {
    const result = await buildSanitizedEveEnvironment({
      appRoot: "/app",
      hostEnvironment: { PATH: "/bin", AI_GATEWAY_API_KEY: "gateway-secret" },
      readEnvironmentFile: envReader({
        ".env.local": [
          "GITHUB_TOKEN=dotenv-github-secret",
          "GH_TOKEN=dotenv-gh-secret",
          "DATABASE_URL=postgres://secret",
          "EVE_TRACES_CONTENT=on",
          "SENTRY_AUTH_TOKEN=secret",
        ].join("\n"),
      }),
    });

    expect(result.environment.GITHUB_TOKEN).toBe("");
    expect(result.environment.GH_TOKEN).toBe("");
    expect(result.environment.EVE_TRACES_CONTENT).toBe("off");
    expect(result.githubToken).toBe("dotenv-github-secret");
    expect(result.environment.DATABASE_URL).toBe("");
    expect(result.environment.SENTRY_AUTH_TOKEN).toBe("");
  });

  it("can resolve an allowed credential from an app-local env file", async () => {
    const result = await buildSanitizedEveEnvironment({
      appRoot: "/app",
      hostEnvironment: { PATH: "/bin" },
      readEnvironmentFile: envReader({
        ".env.local": "VERCEL_OIDC_TOKEN=local-oidc",
      }),
    });
    expect(result.credentialKind).toBe("VERCEL_OIDC_TOKEN");
    expect(result.environment.VERCEL_OIDC_TOKEN).toBe("local-oidc");
    expect(result.environment.AI_GATEWAY_API_KEY).toBe("");
  });

  it("returns an app-local GitHub token only to the trusted host", async () => {
    const result = await buildSanitizedEveEnvironment({
      appRoot: "/app",
      hostEnvironment: { AI_GATEWAY_API_KEY: "gateway-key" },
      readEnvironmentFile: envReader({
        ".env.local": "GITHUB_TOKEN=host-only-token",
      }),
    });
    expect(result.githubToken).toBe("host-only-token");
    expect(result.environment.GITHUB_TOKEN).toBe("");
    expect(Object.values(result.environment)).not.toContain("host-only-token");
  });

  it("uses process values first and dotenv precedence second", async () => {
    const processWins = await buildSanitizedEveEnvironment({
      appRoot: "/app",
      hostEnvironment: { AI_GATEWAY_API_KEY: "process-key" },
      readEnvironmentFile: envReader({
        ".env.development.local": "AI_GATEWAY_API_KEY=development-local-key",
        ".env.local": "AI_GATEWAY_API_KEY=local-key",
      }),
    });
    expect(processWins.environment.AI_GATEWAY_API_KEY).toBe("process-key");

    const highestFileWins = await buildSanitizedEveEnvironment({
      appRoot: "/app",
      hostEnvironment: {},
      readEnvironmentFile: envReader({
        ".env.development.local": "AI_GATEWAY_API_KEY=development-local-key",
        ".env.local": "AI_GATEWAY_API_KEY=local-key",
      }),
    });
    expect(highestFileWins.environment.AI_GATEWAY_API_KEY).toBe(
      "development-local-key"
    );
  });

  it("uses the documented default model", async () => {
    const result = await buildSanitizedEveEnvironment({
      appRoot: "/app",
      hostEnvironment: { AI_GATEWAY_API_KEY: "key" },
      readEnvironmentFile: envReader({}),
    });
    expect(result.model).toBe("anthropic/claude-sonnet-5");
  });

  it("fails with exit-code-2 configuration errors when credentials or env files are invalid", async () => {
    await expect(
      buildSanitizedEveEnvironment({
        appRoot: "/app",
        hostEnvironment: {},
        readEnvironmentFile: envReader({}),
      })
    ).rejects.toBeInstanceOf(FactoryConfigurationError);

    await expect(
      buildSanitizedEveEnvironment({
        appRoot: "/app",
        hostEnvironment: { AI_GATEWAY_API_KEY: "key" },
        readEnvironmentFile: async () => {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        },
      })
    ).rejects.toBeInstanceOf(FactoryConfigurationError);
  });
});
