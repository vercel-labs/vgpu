import { build, type Plugin } from "esbuild";
import type { ShaderSource } from "../../src/types.ts";
import wgslWebpackLoader from "../../src/loader-webpack/index.ts";

let evaluationId = 0;

export async function evaluateShaderModule(code: string): Promise<ShaderSource> {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents: code,
      loader: "js",
      resolveDir: process.cwd(),
      sourcefile: "generated-shader-module.js",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    plugins: [packedWgslPlugin()],
  });
  const output = result.outputFiles[0]?.text;
  if (output === undefined) throw new Error("esbuild emitted no shader module");
  const url = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}#${evaluationId++}`;
  const loaded = await import(/* @vite-ignore */ url) as { readonly default: ShaderSource };
  return loaded.default;
}

function packedWgslPlugin(): Plugin {
  return {
    name: "vgpu-packed-wgsl-test",
    setup(build) {
      build.onResolve({ filter: /\.wgsl\?/ }, (args) => {
        return {
          path: args.path,
          namespace: "vgpu-packed-wgsl",
        };
      });
      build.onLoad({ filter: /.*/, namespace: "vgpu-packed-wgsl" }, (args) => {
        const queryStart = args.path.indexOf("?");
        const resourcePath = args.path.slice(0, queryStart);
        const resourceQuery = args.path.slice(queryStart);
        const contents = wgslWebpackLoader.call({
          resourcePath,
          resourceQuery,
        }, "");
        if (typeof contents !== "string") throw new Error("packed metadata loader became asynchronous");
        return { contents, loader: "js" };
      });
    },
  };
}
