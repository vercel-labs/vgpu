export const browserHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>vgpu browser-vite</title>
    <style>
      html, body, canvas { width: 100%; height: 100%; margin: 0; display: block; }
    </style>
  </head>
  <body>
    <canvas aria-label="vgpu output"></canvas>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

export const browserViteConfig = `import { fileURLToPath, URL } from "node:url";

function shim(path) {
  return fileURLToPath(new URL("./src/vite-node-shims/" + path, import.meta.url));
}

export default {
  build: { target: "es2022" },
  resolve: {
    alias: {
      "node:crypto": shim("crypto.ts"),
      "node:fs/promises": shim("fs-promises.ts"),
      "node:fs": shim("fs.ts"),
      "node:module": shim("module.ts"),
      "node:path": shim("path.ts"),
    },
  },
};
`;

export const browserNodeShims = {
  "crypto.ts": `type Hash = { update(input: string): Hash; digest(encoding?: "hex"): string };
export function createHash(_algorithm = "sha256"): Hash {
  let text = "";
  return {
    update(input: string) { text += input; return this; },
    digest() {
      let h = 2166136261;
      for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
      return (h >>> 0).toString(16).padStart(8, "0").repeat(8);
    },
  };
}
`,
  "fs.ts": `export function existsSync(): boolean { return false; }
export function readFileSync(): never { throw new Error("node:fs is unavailable in the browser template. Use raw WGSL strings or a Vite WGSL loader."); }
export function statSync(): never { throw new Error("node:fs is unavailable in the browser template. Use raw WGSL strings or a Vite WGSL loader."); }
`,
  "fs-promises.ts": `export async function readFile(): Promise<never> { throw new Error("node:fs/promises is unavailable in the browser template. Use raw WGSL strings or a Vite WGSL loader."); }
`,
  "module.ts": `export function createRequire(): () => never { return () => { throw new Error("node:module is unavailable in the browser template."); }; }
`,
  "path.ts": `export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}
export function extname(path: string): string {
  const base = path.split("/").pop() ?? "";
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index);
}
export function join(...parts: string[]): string { return normalize(parts.filter(Boolean).join("/")); }
export function normalize(path: string): string {
  let out = path;
  while (out.includes("//")) out = out.split("//").join("/");
  return out;
}
export function resolve(...parts: string[]): string { return normalize(parts.filter(Boolean).join("/")); }
`,
};

export const browserSource = `import { init } from "vgpu";

const shader = /* wgsl */ \`
struct Params { time: f32, speed: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(uv, sin(params.time * params.speed) * 0.5 + 0.5, 1.0);
}
\`;

async function main() {
  const canvas = document.querySelector("canvas");
  if (!canvas) throw new Error("Missing <canvas>.");
  const gpu = await init();
  const surface = gpu.surface(canvas, { dpr: [1, 2] });
  const effect = gpu.effect(shader, { set: { speed: 2 } });
  gpu.frame.loop((frame) => {
    effect.set({ time: gpu.time });
    frame.pass({ target: surface }, (p) => p.draw(effect));
  });
}

main().catch((error) => {
  console.error(error);
});
`;
