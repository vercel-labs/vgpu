export const RELEASE_PACKAGES = Object.freeze([
  Object.freeze({ name: "vgpu", directory: "packages/vgpu-api" }),
  Object.freeze({ name: "@vgpu/core", directory: "packages/core" }),
  Object.freeze({ name: "@vgpu/wgsl", directory: "packages/wgsl" }),
  Object.freeze({ name: "@vgpu/wgsl-std", directory: "packages/wgsl-std" }),
  Object.freeze({
    name: "@vgpu/adapter-node",
    directory: "packages/adapter-node",
  }),
  Object.freeze({
    name: "@vgpu/adapter-mock",
    directory: "packages/adapter-mock",
  }),
  Object.freeze({ name: "@vgpu/render", directory: "packages/render" }),
]);

export function validateReleasePackages({
  configuredFixedPackageNames,
  manifests,
  expectedVersion,
}) {
  const expectedNames = new Set(RELEASE_PACKAGES.map(({ name }) => name));
  const configuredNameCounts = new Map();
  const manifestsByPath = new Map();
  const manifestPathsByName = new Map();
  const errors = [];

  for (const packageName of configuredFixedPackageNames) {
    configuredNameCounts.set(
      packageName,
      (configuredNameCounts.get(packageName) ?? 0) + 1
    );
  }

  for (const entry of manifests) {
    if (manifestsByPath.has(entry.manifestPath)) {
      errors.push(`${entry.manifestPath}: duplicate workspace manifest path`);
      continue;
    }
    manifestsByPath.set(entry.manifestPath, entry);

    const packageName = entry.manifest.name;
    if (typeof packageName === "string") {
      const paths = manifestPathsByName.get(packageName) ?? [];
      paths.push(entry.manifestPath);
      manifestPathsByName.set(packageName, paths);
    }
  }

  for (const { name, directory } of RELEASE_PACKAGES) {
    const fixedCount = configuredNameCounts.get(name) ?? 0;
    if (fixedCount === 0) {
      errors.push(`${name}: missing from the Changesets fixed group`);
    } else if (fixedCount > 1) {
      errors.push(`${name}: duplicated in the Changesets fixed group`);
    }

    const manifestPath = `${directory}/package.json`;
    const entry = manifestsByPath.get(manifestPath);
    if (!entry) {
      errors.push(`${name}: package.json not found at ${manifestPath}`);
      continue;
    }
    if (entry.manifest.name !== name) {
      errors.push(
        `${manifestPath}: package name ${
          entry.manifest.name ?? "missing"
        } (expected ${name})`
      );
    }
    if (entry.manifest.private !== false) {
      errors.push(`${name}: package.json must set private to false`);
    }
    const repository = entry.manifest.repository;
    if (
      repository === null ||
      typeof repository !== "object" ||
      Array.isArray(repository) ||
      Object.keys(repository).length !== 3 ||
      repository.type !== "git" ||
      repository.url !== "git+https://github.com/vercel-labs/vgpu.git" ||
      repository.directory !== directory
    ) {
      errors.push(`${name}: package.json has invalid repository metadata`);
    }
    const publishConfig = entry.manifest.publishConfig;
    if (
      publishConfig === null ||
      typeof publishConfig !== "object" ||
      Array.isArray(publishConfig) ||
      Object.keys(publishConfig).length !== 1 ||
      publishConfig.access !== "public"
    ) {
      errors.push(
        `${name}: publishConfig must be exactly { access: "public" }`
      );
    }
    if (entry.manifest.version !== expectedVersion) {
      errors.push(
        `${name}: ${
          entry.manifest.version ?? "missing version"
        } (expected ${expectedVersion})`
      );
    }
  }

  for (const packageName of configuredNameCounts.keys()) {
    if (!expectedNames.has(packageName)) {
      errors.push(
        `${packageName}: unexpected package in the Changesets fixed group`
      );
    }
  }

  for (const [packageName, manifestPaths] of manifestPathsByName) {
    if (manifestPaths.length > 1) {
      errors.push(
        `${packageName}: duplicate workspace package name at ${manifestPaths.join(
          " and "
        )}`
      );
    }
  }

  for (const { manifestPath, manifest } of manifests) {
    if (manifest.private !== true && !expectedNames.has(manifest.name)) {
      errors.push(
        `${
          manifest.name ?? manifestPath
        }: public workspace package missing from the release allowlist`
      );
    }
  }

  return errors;
}
