import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { create, globals } from "webgpu";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
Object.assign(globalThis, globals);
const dawn = create([]);
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: dawn } });
Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
const adapter = await dawn.requestAdapter({ featureLevel: "compatibility" } as GPURequestAdapterOptions);
const dist = resolve(root, "node_modules/onnxruntime-web/dist");
const ort: any = await import(pathToFileURL(resolve(dist, "ort.webgpu.bundle.min.mjs")).href);
ort.env.webgpu.adapter = adapter;
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { mjs: resolve(dist, "ort-wasm-simd-threaded.mjs"), wasm: resolve(dist, "ort-wasm-simd-threaded.wasm") };
ort.env.wasm.wasmBinary = new Uint8Array(await readFile(ort.env.wasm.wasmPaths.wasm));
try {
  await ort.InferenceSession.create(new Uint8Array(await readFile(resolve(root, "fixtures/models/identity-1x1x4x4.onnx"))), { executionProviders: ["webgpu"] });
  throw new Error("generic WASM unexpectedly initialized the WebGPU EP");
} catch (error) {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  console.log(text);
  if (!text.includes("webgpuInit is not a function")) throw error;
  console.log("NEGATIVE_PASS generic WASM failed with webgpuInit is not a function");
}
