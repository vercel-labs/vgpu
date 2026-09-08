import { createHash } from "node:crypto";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { MetalCompileError } from "./errors.js";

export function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export async function resolveMetalSource(
  entry: string,
  inputModules: Readonly<Record<string, string>>
) {
  try {
    assertVirtualPath(entry);
    const modules: Record<string, string> = Object.create(null);
    for (const name of Object.keys(inputModules).sort()) {
      assertVirtualPath(name);
      const source = inputModules[name];
      if (
        typeof source !== "string" ||
        !isWellFormed(source) ||
        source.includes("\0")
      ) {
        throw new Error(`module ${name} must contain well-formed WGSL text`);
      }
      modules[name] = source;
    }
    const resolved = await resolveShader({
      entry,
      modules,
      rootDir: ".",
      validate: false,
      minify: false,
    });
    if (
      resolved.deps.some((dependency) => !Object.hasOwn(modules, dependency))
    ) {
      throw new Error("source resolution escaped the explicit module map");
    }
    const source = {
      virtualPath: "Intermediate/resolved.wgsl",
      text: resolved.wgsl,
      sha256: sha256(resolved.wgsl),
    };
    // The first compiler adapter promises resolved-source diagnostics only.
    // Empty segments explicitly make no authored line/column claim.
    const originMap = {
      schemaVersion: 1,
      contractId: "vgpu-native-origin-map/v1",
      generatedSource: {
        virtualPath: source.virtualPath,
        sha256: source.sha256,
      },
      sources: resolved.deps
        .slice()
        .sort()
        .map((name) => ({ input: name, sha256: sha256(modules[name]) })),
      segments: [],
    };
    return {
      source,
      originMap,
      originMapSha256: sha256(canonicalJSON(originMap)),
      languageFeatures: [],
    };
  } catch (cause) {
    throw new MetalCompileError(
      "source",
      `WGSL source resolution failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }
}

function assertVirtualPath(value: string): void {
  if (
    typeof value !== "string" ||
    !isWellFormed(value) ||
    value.normalize("NFC") !== value ||
    value.startsWith("/") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    /[\\\u0000-\u001f\u007f]/u.test(value) ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      "source paths must be canonical configuration-relative paths"
    );
  }
}

function isWellFormed(value: string): boolean {
  return !/[\uD800-\uDFFF]/u.test(value);
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJSON(
            (value as Record<string, unknown>)[key]
          )}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
