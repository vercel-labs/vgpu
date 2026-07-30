// Pinned recipe: Node 22, webgpu 0.4.0, onnxruntime-web 1.27.0, vgpu 0.1.6.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { create, globals } from "webgpu"; // supported public package path
import { initFromDevice } from "../../../packages/vgpu-api/dist/node.js";
Object.assign(globalThis, globals);
const dawn = create([]); // exactly one singleton
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: dawn } });
Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
const adapter = await dawn.requestAdapter({ featureLevel: "compatibility" });
const dist = resolve("node_modules/onnxruntime-web/dist");
const ort = await import(pathToFileURL(resolve(dist, "ort.webgpu.bundle.min.mjs")));
ort.env.webgpu.adapter = adapter;
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { mjs: resolve(dist, "ort-wasm-simd-threaded.asyncify.mjs"), wasm: resolve(dist, "ort-wasm-simd-threaded.asyncify.wasm") };
ort.env.wasm.wasmBinary = new Uint8Array(await readFile(ort.env.wasm.wasmPaths.wasm));
// Create and run an ORT WebGPU session first, then adopt its exact device:
const gpu = await initFromDevice(await ort.env.webgpu.device);
// ... stop producers, submit, await gpu.device.queue.flush(), dispose wrappers ...
gpu.dispose();
// await session.release();
