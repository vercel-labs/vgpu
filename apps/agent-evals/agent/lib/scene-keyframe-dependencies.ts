import { createHash } from "node:crypto";
import type { SandboxSession } from "eve/sandbox";

interface DependencySources {
  packageJsonText: string | null;
  packageLockText: string | null;
  mathPackageText: string | null;
  wgpuMatrixPackageText: string | null;
  threePackageText: string | null;
  dependencyTreeText: string | null;
}

interface PackageObservation {
  present: boolean;
  version: string | null;
}

export interface SceneKeyframeDependencySnapshot {
  schemaVersion: 1;
  observedAt: string;
  packageJson: {
    sha256: string | null;
    parseError: string | null;
    dependencyFields: Record<string, Record<string, unknown>>;
    mathFields: string[];
  };
  packageLock: {
    sha256: string | null;
    parseError: string | null;
    mathPaths: string[];
  };
  dependencyTree: {
    sha256: string | null;
    mathVersions: (string | null)[];
    parseError: string | null;
  };
  packages: {
    math: PackageObservation;
    wgpuMatrix: PackageObservation;
    three: PackageObservation;
  };
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

export function analyzeSceneKeyframeDependencies(sources: DependencySources): SceneKeyframeDependencySnapshot {
  const packageJson = parseJson(sources.packageJsonText);
  const packageLock = parseJson(sources.packageLockText);
  const dependencyTree = parseJson(sources.dependencyTreeText);
  const dependencyFields = Object.fromEntries(DEPENDENCY_FIELDS.flatMap((field) => {
    const value = packageJson.value?.[field];
    return value && typeof value === "object" && !Array.isArray(value) ? [[field, value]] : [];
  }));
  const mathFields = Object.entries(dependencyFields)
    .filter(([, dependencies]) => Object.hasOwn(dependencies, "math"))
    .map(([field]) => field);
  const lockPackages = packageLock.value?.packages;
  const packageLockError = packageLock.error ?? (
    !lockPackages || typeof lockPackages !== "object" || Array.isArray(lockPackages)
      ? "packages is missing or is not an object"
      : null
  );
  const mathPaths = lockPackages && typeof lockPackages === "object" && !Array.isArray(lockPackages)
    ? Object.keys(lockPackages).filter((path) => path === "node_modules/math" || path.endsWith("/node_modules/math"))
    : [];
  return {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    packageJson: {
      sha256: digest(sources.packageJsonText),
      parseError: packageJson.error,
      dependencyFields,
      mathFields,
    },
    packageLock: {
      sha256: digest(sources.packageLockText),
      parseError: packageLockError,
      mathPaths,
    },
    dependencyTree: {
      sha256: digest(sources.dependencyTreeText),
      mathVersions: dependencyVersions(dependencyTree.value, "math"),
      parseError: dependencyTree.error,
    },
    packages: {
      math: packageObservation(sources.mathPackageText),
      wgpuMatrix: packageObservation(sources.wgpuMatrixPackageText),
      three: packageObservation(sources.threePackageText),
    },
  };
}

export function initialMathAbsenceErrors(snapshot: SceneKeyframeDependencySnapshot): string[] {
  const errors: string[] = [];
  if (snapshot.packageJson.parseError) {
    errors.push(`package.json is unavailable or invalid: ${snapshot.packageJson.parseError}`);
  }
  if (snapshot.packageLock.parseError) {
    errors.push(`package-lock.json is unavailable or invalid: ${snapshot.packageLock.parseError}`);
  }
  if (snapshot.packages.math.present) errors.push("node_modules/math is present");
  if (snapshot.packageLock.mathPaths.length > 0) {
    errors.push(`package-lock contains ${snapshot.packageLock.mathPaths.join(", ")}`);
  }
  if (snapshot.packageJson.mathFields.length > 0) {
    errors.push(`package.json declares math in ${snapshot.packageJson.mathFields.join(", ")}`);
  }
  if (snapshot.dependencyTree.parseError) {
    errors.push(`npm ls dependency tree is invalid: ${snapshot.dependencyTree.parseError}`);
  } else if (snapshot.dependencyTree.mathVersions.length > 0) {
    errors.push("npm ls math --all is not empty");
  }
  return errors;
}

export async function observeSceneKeyframeDependencies(
  sandbox: SandboxSession,
): Promise<SceneKeyframeDependencySnapshot> {
  const [
    packageJsonText,
    packageLockText,
    mathPackageText,
    wgpuMatrixPackageText,
    threePackageText,
    dependencyTree,
  ] = await Promise.all([
    sandbox.readTextFile({ path: "/workspace/package.json" }),
    sandbox.readTextFile({ path: "/workspace/package-lock.json" }),
    sandbox.readTextFile({ path: "/workspace/node_modules/math/package.json" }),
    sandbox.readTextFile({ path: "/workspace/node_modules/wgpu-matrix/package.json" }),
    sandbox.readTextFile({ path: "/workspace/node_modules/three/package.json" }),
    sandbox.run({ command: "npm ls math --all --json || true", workingDirectory: "/workspace" }),
  ]);
  return analyzeSceneKeyframeDependencies({
    packageJsonText,
    packageLockText,
    mathPackageText,
    wgpuMatrixPackageText,
    threePackageText,
    dependencyTreeText: dependencyTree.stdout ?? null,
  });
}

function dependencyVersions(value: unknown, name: string): (string | null)[] {
  const versions: (string | null)[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const record = node as Record<string, unknown>;
    const dependencies = record.dependencies;
    if (dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)) {
      for (const [dependencyName, dependency] of Object.entries(dependencies)) {
        if (dependencyName === name) {
          versions.push(dependency && typeof dependency === "object" && !Array.isArray(dependency)
            && typeof (dependency as Record<string, unknown>).version === "string"
            ? (dependency as Record<string, unknown>).version as string
            : null);
        }
        visit(dependency);
      }
    }
  };
  visit(value);
  return versions;
}

function packageObservation(source: string | null): PackageObservation {
  const parsed = parseJson(source);
  return {
    present: source !== null,
    version: typeof parsed.value?.version === "string" ? parsed.value.version : null,
  };
}

function parseJson(source: string | null): { value: Record<string, any> | null; error: string | null } {
  if (source === null) return { value: null, error: "missing" };
  try {
    const value = JSON.parse(source) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? { value: value as Record<string, any>, error: null }
      : { value: null, error: "root is not an object" };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function digest(value: string | null): string | null {
  return value === null ? null : createHash("sha256").update(value).digest("hex");
}
