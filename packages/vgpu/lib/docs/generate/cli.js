#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDocs } from "./generate.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const manifestOut = resolve(root, "packages/vgpu/lib/generated/docs-manifest.generated.js");
// Root-level skills/ dir (skills-repo convention): <repo>/skills/vgpu.
const skillDir = resolve(root, "skills/vgpu");

const { manifest } = generateDocs({ root, skillDir, manifestOut });

const guideCount = manifest.records.filter((record) => record.kind === "guide").length;
console.log(
  `docs: ${manifest.records.length} records (${guideCount} guides) → manifest + thin skill router at ${skillDir}`,
);
