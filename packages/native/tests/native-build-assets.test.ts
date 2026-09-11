import { exec } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const run = promisify(exec);

test("workspace and package builds include the native source asset from a clean isolated dist", async () => {
  for (const entrypoint of ["workspace", "package"]) {
    const fixture = await mkdtemp(join(tmpdir(), "vgpu-native-build-assets-"));
    try {
      const native = join(fixture, "packages/native");
      const put = async (path: string, content: string) => {
        const target = join(fixture, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      };
      const copy = async (path: string) => {
        const target = join(fixture, path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(join(repository, path), target);
      };
      await copy("package.json");
      await copy("packages/native/package.json");
      await copy("packages/native/src/tooling/publication-session.c");
      await copy("packages/native/src/tooling/publication-staging.c");
      await copy("packages/vgpu-api/scripts/copy-cli.mjs");
      await copy("packages/native/scripts/copy-assets.mjs");
      await put(
        "tsconfig.json",
        JSON.stringify({ files: [], references: [{ path: "packages/native" }] })
      );
      await put(
        "packages/native/tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            composite: true,
            types: [],
            rootDir: "src",
            outDir: "dist",
          },
          include: ["src/**/*.ts"],
        })
      );
      await put(
        "packages/native/src/tooling/marker.ts",
        "export const marker = 1;\n"
      );
      await put(
        "packages/vgpu-api/package.json",
        JSON.stringify({ version: "0.0.0" })
      );
      await put("packages/vgpu/bin/marker.js", "export const cli = 1;\n");
      await put("packages/vgpu/lib/marker.js", "export const library = 1;\n");
      await put(
        "packages/wgsl/src/wgsl-types.d.ts",
        "export type Marker = number;\n"
      );
      await mkdir(join(fixture, "packages/wgsl/dist"), { recursive: true });

      const cwd = entrypoint === "workspace" ? fixture : native;
      const manifest = JSON.parse(
        await readFile(join(cwd, "package.json"), "utf8")
      );
      await run(manifest.scripts.build, {
        cwd,
        env: {
          ...process.env,
          PATH: `${join(repository, "node_modules/.bin")}${delimiter}${
            process.env.PATH ?? ""
          }`,
        },
        timeout: 20_000,
      });
      expect(
        await readFile(join(native, "dist/tooling/publication-session.c"))
      ).toEqual(
        await readFile(join(native, "src/tooling/publication-session.c"))
      );
      expect(
        await readFile(join(native, "dist/tooling/publication-staging.c"))
      ).toEqual(
        await readFile(join(native, "src/tooling/publication-staging.c"))
      );
      expect(
        await readFile(join(native, "dist/tooling/marker.js"), "utf8")
      ).toContain("marker");
      if (entrypoint === "workspace") {
        expect(
          await readFile(
            join(fixture, "packages/vgpu-api/dist/cli/bin/marker.js"),
            "utf8"
          )
        ).toContain("cli");
        expect(
          await readFile(
            join(fixture, "packages/wgsl/dist/wgsl-types.d.ts"),
            "utf8"
          )
        ).toContain("Marker");
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }
}, 30_000);
