import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const defaultTemplate = "node-headless";
const templates = new Set([defaultTemplate, "browser-vite"]);

export function runCreate(args) {
  const parsed = parseArgs(args);
  if (parsed.help) return { code: 0, stdout: help() };
  if (!parsed.name) return { code: 1, stderr: help() };
  if (!templates.has(parsed.template)) return { code: 1, stderr: `Unknown vgpu create template: ${parsed.template}\n\n${help()}` };

  const baseDir = createBaseDir();
  const workspaceMode = hasWorkspacePackages(baseDir);
  const root = resolve(baseDir, parsed.name);
  if (existsSync(root)) return { code: 1, stderr: `Cannot create '${parsed.name}': path already exists.\n` };
  writeTemplate(root, parsed.name, parsed.template, workspaceMode);
  return { code: 0, stdout: `Created ${parsed.name} with ${parsed.template}.\nNext steps:\n  cd ${parsed.name}\n  pnpm typecheck\n` };
}

function parseArgs(args) {
  let template = defaultTemplate;
  let helpRequested = false;
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") helpRequested = true;
    else if (arg === "--template" || arg === "-t") template = args[++i] ?? "";
    else if (arg.startsWith("--template=")) template = arg.slice("--template=".length);
    else positionals.push(arg);
  }
  return { help: helpRequested, name: positionals[0], template };
}

function createBaseDir() {
  return findWorkspaceRoot(process.cwd()) ?? process.cwd();
}

function findWorkspaceRoot(startDir) {
  for (let dir = startDir;; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

function hasWorkspacePackages(baseDir) {
  return existsSync(resolve(baseDir, "packages/vgpu-api/src"));
}

function writeTemplate(root, name, template, workspaceMode) {
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify(packageJson(name, template, workspaceMode), null, 2)}\n`);
  writeFileSync(resolve(root, "tsconfig.json"), `${JSON.stringify(tsconfig(workspaceMode), null, 2)}\n`);
  writeFileSync(resolve(root, "src/main.ts"), sourceFor(template));
}

function packageJson(name, template, workspaceMode) {
  return {
    name,
    private: true,
    type: "module",
    scripts: {
      typecheck: "tsc --noEmit",
      dev: template === "browser-vite" ? "vite" : "tsx src/main.ts",
    },
    dependencies: {
      vgpu: workspaceMode ? "workspace:*" : "^0.0.8",
    },
    devDependencies: {
      "@types/node": "^22.10.7",
      "@webgpu/types": "^0.1.69",
      tsx: "^4.19.2",
      typescript: "^5.7.3",
      ...(template === "browser-vite" ? { vite: "^5.4.11" } : {}),
    },
  };
}

function tsconfig(workspaceMode) {
  const compilerOptions = {
    target: "ES2022",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    skipLibCheck: true,
    types: ["node", "@webgpu/types"],
  };
  if (workspaceMode) {
    compilerOptions.allowImportingTsExtensions = true;
    compilerOptions.baseUrl = ".";
    compilerOptions.paths = {
      "vgpu": ["../packages/vgpu-api/src/index.ts"],
      "vgpu/*": ["../packages/vgpu-api/src/*.ts"],
    };
  }
  return { compilerOptions, include: ["src/**/*.ts"] };
}

function sourceFor(template) {
  if (template === "browser-vite") return browserSource;
  return nodeSource;
}

const nodeSource = `import { init } from "vgpu/node";

const shader = /* wgsl */ \`
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time * params.speed) * 0.5 + 0.5, 1.0);
}
\`;

const gpu = await init({ size: [256, 256] });
const target = gpu.target({ format: "rgba8unorm" });
const pass = gpu.pass(shader, { set: { time: 1.25, speed: 1 } });
pass.draw({ target });
console.log((await target.read()).byteLength);
gpu.dispose();
`;

const browserSource = `import { init } from "vgpu";

const canvas = document.querySelector("canvas");
if (!canvas) throw new Error("Missing <canvas>.");

const shader = /* wgsl */ \`
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time * params.speed) * 0.5 + 0.5, 1.0);
}
\`;

const gpu = await init(canvas, { dpr: [1, 2] });
const pass = gpu.pass(shader, { set: { speed: 2 } });
gpu.frame.loop(() => {
  pass.set({ time: gpu.time });
  pass.draw();
});
`;

function help() {
  return `Usage: vgpu create <name> [--template node-headless|browser-vite]\n\nScaffold a minimal ring-1 VGPU project.\n`;
}
