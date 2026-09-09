#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { validateReleasePackages } from "./lib/release-packages.mjs";

const expectedVersion = process.env.EXPECTED_VERSION;
if (!expectedVersion) {
  throw new Error("Missing required environment variable EXPECTED_VERSION.");
}

const config = JSON.parse(fs.readFileSync(".changeset/config.json", "utf8"));
const workspaceRoots = ["packages", "examples", "apps"];
const manifests = workspaceRoots.flatMap((root) =>
  fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name, "package.json"))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => ({
      manifestPath,
      manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    }))
);
const errors = validateReleasePackages({
  configuredFixedPackageNames: config.fixed.flat(),
  manifests,
  expectedVersion,
});

if (errors.length > 0) {
  const message = `Release package validation failed: ${errors.join(", ")}`
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  console.error(`::error::${message}`);
  process.exitCode = 1;
} else {
  console.log(
    `Release package validation accepted exactly seven public packages at ${expectedVersion}.`
  );
}
