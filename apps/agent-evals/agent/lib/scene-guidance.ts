import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxSession } from "eve/sandbox";
import { tarballsDir } from "./paths.ts";

interface GuidanceManifest {
  tarballs?: { name?: string; version?: string }[];
  sceneGuidance?: {
    variant?: string;
    docsSha256?: string;
    dependency?: { name?: string; version?: string };
  };
}

export async function observeSceneGuidanceInstall(sandbox: SandboxSession) {
  let manifest: GuidanceManifest;
  try {
    manifest = JSON.parse(readFileSync(join(tarballsDir(), "tarballs.json"), "utf8"));
  } catch {
    return null;
  }
  const guidance = manifest.sceneGuidance;
  if (!guidance?.docsSha256) return null;
  const expectedVgpu = manifest.tarballs?.find((entry) => entry.name === "vgpu")?.version ?? "unavailable";
  const expectedMath = guidance.dependency?.version ?? "unavailable";
  const base = {
    condition: guidance.variant ?? "unavailable",
    expected: { docsSha256: guidance.docsSha256, vgpuVersion: expectedVgpu, mathVersion: expectedMath },
    observedAt: new Date().toISOString(),
  };
  try {
    const located = await sandbox.run({
      command:
        "find node_modules -type f -path '*/dist/cli/lib/generated/docs-manifest.generated.js' -print",
      workingDirectory: "/workspace",
    });
    const docsManifestPaths = (located.stdout ?? "").split("\n").map((value) => value.trim()).filter(Boolean);
    const docsBytes = docsManifestPaths.length === 1
      ? await sandbox.readBinaryFile({ path: `/workspace/${docsManifestPaths[0]}` })
      : null;
    const mathText = await sandbox.readTextFile({ path: "/workspace/node_modules/math/package.json" });
    const vgpuText = await sandbox.readTextFile({ path: "/workspace/node_modules/vgpu/package.json" });
    const mathVersion = packageVersion(mathText);
    const vgpuVersion = packageVersion(vgpuText);
    const docsSha256 = docsBytes ? sha256(docsBytes) : null;
    const protocolDeviation =
      docsManifestPaths.length !== 1
      || docsSha256 !== guidance.docsSha256
      || mathVersion !== expectedMath
      || vgpuVersion !== expectedVgpu;
    return {
      ...base,
      observed: { docsSha256, docsManifestPaths, vgpuVersion, mathVersion },
      protocolDeviation,
    };
  } catch (error) {
    return {
      ...base,
      observed: null,
      protocolDeviation: true,
      observationError: error instanceof Error ? error.message : String(error),
    };
  }
}

function packageVersion(source: string | null): string | null {
  if (!source) return null;
  try {
    const parsed = JSON.parse(source) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
