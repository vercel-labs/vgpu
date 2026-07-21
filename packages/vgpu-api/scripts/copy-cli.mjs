import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = resolve(packageDir, "../vgpu");
const outputDir = resolve(packageDir, "dist/cli");
const { version } = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(resolve(cliDir, "bin"), resolve(outputDir, "bin"), { recursive: true });
cpSync(resolve(cliDir, "lib"), resolve(outputDir, "lib"), { recursive: true });
writeFileSync(resolve(outputDir, "package.json"), `${JSON.stringify({ type: "module", version }, null, 2)}\n`);
