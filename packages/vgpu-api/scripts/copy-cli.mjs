import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = resolve(packageDir, "../vgpu");
const outputDir = resolve(packageDir, "dist/cli");
const { version } = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
// packages/vgpu/package.json keeps these two out of the @vgpu/cli tarball via `files` negations:
// they are repo-only tools (the geistdocs content target and its parity gate) that nothing in bin/
// or lib/ imports — they only ever run from a checkout. This copy feeds `dist/cli` of the published
// `vgpu` package, and npm's `files` negations do not reach through a recursive copy, so the same
// exclusion has to be repeated here or the files ship anyway.
const devOnlyCliFiles = new Set([
  resolve(cliDir, "lib/docs/generate/generate-geistdocs.js"),
  resolve(cliDir, "lib/docs/generate/check-docs-content.mjs"),
]);

cpSync(resolve(cliDir, "bin"), resolve(outputDir, "bin"), { recursive: true });
cpSync(resolve(cliDir, "lib"), resolve(outputDir, "lib"), {
  recursive: true,
  filter: (source) => !devOnlyCliFiles.has(source),
});
writeFileSync(resolve(outputDir, "package.json"), `${JSON.stringify({ type: "module", version }, null, 2)}\n`);
