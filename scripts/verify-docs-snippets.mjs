#!/usr/bin/env node
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repo = process.cwd();
const list = spawnSync("git", ["ls-files", "*.docs.md", ":!:skills/**"], { cwd: repo, encoding: "utf8" });
if (list.status !== 0) {
  process.stderr.write(list.stderr);
  process.exit(list.status ?? 1);
}

const files = list.stdout.trim().split(/\r?\n/u).filter(Boolean);
const out = mkdtempSync(join(repo, ".tmp-doc-snippets-"));
let snippets = 0;

function isAmbientSnippet(code) {
  const trimmed = code.trim();
  return /^declare\s/u.test(trimmed)
    || /^interface\s/u.test(trimmed)
    || /^type\s/u.test(trimmed)
    || /^export\s+interface\s/u.test(trimmed)
    || /^export\s+type\s/u.test(trimmed)
    || /^(?:export\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*[^{}]*;\s*$/su.test(trimmed);
}

try {
  for (const file of files) {
    const text = readFileSync(join(repo, file), "utf8");
    let block = 0;
    for (const match of text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/gu)) {
      block += 1;
      const lang = match[1].trim().toLowerCase();
      if (lang !== "ts" && lang !== "typescript") continue;
      snippets += 1;
      const safe = file.replace(/[^A-Za-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
      let code = match[2].trimEnd();
      const ambient = isAmbientSnippet(code);
      const name = `${String(snippets).padStart(4, "0")}_${safe}_${block}.${ambient ? "d.ts" : "ts"}`;
      if (!ambient && !/\b(import|export)\b/u.test(code)) code += "\nexport {};";
      writeFileSync(join(out, name), code + "\n");
    }
  }

  writeFileSync(join(out, "tsconfig.json"), JSON.stringify({
    extends: join(repo, "tsconfig.base.json"),
    compilerOptions: {
      composite: false,
      declaration: false,
      declarationMap: false,
      sourceMap: false,
      noEmit: true,
      allowImportingTsExtensions: true,
      types: ["node", "@webgpu/types"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      skipLibCheck: true,
      strict: true,
      baseUrl: repo,
      paths: {
        "vgpu": ["packages/vgpu-api/src/index.ts"],
        "vgpu/mock": ["packages/vgpu-api/src/mock.ts"],
        "vgpu/node": ["packages/vgpu-api/src/node.ts"],
        "vgpu/scene": ["packages/vgpu-api/src/scene.ts"],
        "vgpu/core": ["packages/vgpu-api/src/core.ts"],
        "@vgpu/core": ["packages/core/src/index.ts"],
        "@vgpu/adapter-mock": ["packages/adapter-mock/src/index.ts"],
        "@vgpu/adapter-node": ["packages/adapter-node/src/index.ts"],
        "@vgpu/render/inspect": ["packages/render/src/inspect/index.ts"],
        "@vgpu/render/utils": ["packages/render/src/utils/index.ts"],
        "@vgpu/render/perf": ["packages/render/src/perf/index.ts"],
        "@vgpu/render/edit": ["packages/render/src/edit/index.ts"],
        "@vgpu/wgsl": ["packages/wgsl/src/index.ts"],
        "@vgpu/wgsl/runtime": ["packages/wgsl/src/runtime/resolve-shader.ts"],
        "@vgpu/wgsl/loader-vite": ["packages/wgsl/src/loader-vite/index.ts"],
        "@vgpu/wgsl/loader-webpack": ["packages/wgsl/src/loader-webpack/index.ts"],
        "@vgpu/wgsl-std/color": ["packages/wgsl-std/src/color/index.ts"],
        "@vgpu/wgsl-std/constants": ["packages/wgsl-std/src/constants/index.ts"],
        "@vgpu/wgsl-std/fullscreen": ["packages/wgsl-std/src/fullscreen/index.ts"],
        "@vgpu/wgsl-std/hash": ["packages/wgsl-std/src/hash/index.ts"],
        "@vgpu/wgsl-std/light": ["packages/wgsl-std/src/light/index.ts"],
        "@vgpu/wgsl-std/math": ["packages/wgsl-std/src/math/index.ts"],
        "@vgpu/wgsl-std/noise": ["packages/wgsl-std/src/noise/index.ts"],
        "@vgpu/wgsl-std/sampling": ["packages/wgsl-std/src/sampling/index.ts"]
      }
    },
    include: ["*.ts"]
  }, null, 2));

  const tsc = spawnSync("pnpm", ["exec", "tsc", "-p", join(out, "tsconfig.json"), "--noEmit", "--pretty", "false"], { cwd: repo, encoding: "utf8" });
  if (tsc.status === 0) {
    console.log(`snippets=${snippets} tsc=OK`);
  } else {
    process.stdout.write(tsc.stdout);
    process.stderr.write(tsc.stderr);
    console.error(`snippets=${snippets} tsc=FAIL temp=${out}`);
    process.exit(tsc.status ?? 1);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
