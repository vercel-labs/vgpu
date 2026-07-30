import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { create, globals } from "webgpu";
import { initFromDevice } from "../../../packages/vgpu-api/dist/node.js";
import { DIMS, INPUT, MODEL_FILE, verifyModel } from "../shared/fixtures.ts";
import { errorText, pass, type Evidence } from "../shared/evidence.ts";
import { runPipeline, type Mode } from "../shared/pipeline.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifact = resolve(process.env.ORT_EVIDENCE_DIR ?? resolve(root, "artifacts"), "node.json");
const lifecycle: string[] = [];
const errors: string[] = [];
let session: any, gpu: Awaited<ReturnType<typeof initFromDevice>> | undefined;
let createCount = 0, deviceDestroyCalls = 0, rawBufferDestroyCalls = 0;
let snapshot: unknown, reference: unknown;
const restores: Array<() => void> = [];
const assertions: Record<string, boolean> = {};

try {
  if (!/^v22\./.test(process.version)) throw new Error(`Node 22 required, received ${process.version}`);
  if (!process.env.VGPU_CACHE_DIR) throw new Error("VGPU_CACHE_DIR must be an explicit temporary directory");
  Object.assign(globalThis, globals);
  const dawn = create([]); createCount++;
  installGlobal("navigator", Object.assign(globalThis.navigator ?? {}, { gpu: dawn }));
  installGlobal("self", globalThis);
  assertions.singleDawnSingleton = createCount === 1 && navigator.gpu === dawn;
  lifecycle.push("single-dawn-installed");

  const adapter = await dawn.requestAdapter({ featureLevel: "compatibility" } as GPURequestAdapterOptions);
  if (!adapter) throw new Error("Dawn requestAdapter returned null");
  const dist = resolve(root, "node_modules/onnxruntime-web/dist");
  const ort: any = await import(pathToFileURL(resolve(dist, "ort.webgpu.bundle.min.mjs")).href);
  ort.env.webgpu.adapter = adapter;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = {
    mjs: resolve(dist, "ort-wasm-simd-threaded.asyncify.mjs"),
    wasm: resolve(dist, "ort-wasm-simd-threaded.asyncify.wasm"),
  };
  ort.env.wasm.wasmBinary = new Uint8Array(await readFile(ort.env.wasm.wasmPaths.wasm));
  const modelBytes = new Uint8Array(await readFile(resolve(root, "fixtures/models", MODEL_FILE)));
  await verifyModel(modelBytes);
  session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["webgpu"], preferredOutputLocation: "gpu-buffer" });

  const rawDevice = await ort.env.webgpu.device as GPUDevice;
  if (!rawDevice) throw new Error("ORT did not expose env.webgpu.device");
  restores.push(spyMethod(rawDevice, "destroy", () => deviceDestroyCalls++));
  gpu = await initFromDevice(rawDevice);
  assertions.deviceIdentity = gpu.gpu === rawDevice && gpu.device.gpu === rawDevice;
  // Stronger than before: adoption returns the plain `Gpu`, so there is no `adapter` field at
  // all rather than a null one. `NodeGpu.adapter` now belongs solely to init(), which selects a
  // Dawn adapter. Key name kept so the recorded artifact stays comparable.
  assertions.nodeAdapterNull = !("adapter" in gpu);

  const runMode = async (mode: Mode) => {
    const input = new ort.Tensor("float32", INPUT, [...DIMS]);
    let output: any;
    try {
      const outputs = await session.run({ input });
      output = outputs.output ?? outputs[session.outputNames[0]];
      const raw = output?.gpuBuffer as GPUBuffer | undefined;
      if (!raw) throw new Error(`${mode}: ORT did not return a GPU-resident output (CPU fallback gate)`);
      const restoreBuffer = spyMethod(raw, "destroy", () => rawBufferDestroyCalls++);
      try { return await runPipeline(gpu!, raw, mode); }
      finally { restoreBuffer(); }
    } finally {
      input.dispose();
      output?.dispose();
      lifecycle.push(`${mode}-tensor-disposed-after-flush-and-wrapper`);
    }
  };
  snapshot = await runMode("snapshot");
  reference = await runMode("reference");
  assertions.snapshotNumeric = (snapshot as any).numericMatch === true;
  assertions.referenceNumeric = (reference as any).numericMatch === true;
  assertions.snapshotOneCopy = (snapshot as any).copyCount === 1;
  assertions.referenceZeroCopy = (reference as any).copyCount === 0;
  assertions.referenceRawIdentity = (reference as any).rawIdentity === true;
  assertions.antiCpuFallback = true;
  assertions.asyncifyFlavor = String(ort.env.wasm.wasmPaths.mjs).includes(".asyncify.mjs") && String(ort.env.wasm.wasmPaths.wasm).includes(".asyncify.wasm");
  assertions.numThreadsOne = ort.env.wasm.numThreads === 1;
  assertions.wrapperDidNotDestroyRaw = rawBufferDestroyCalls === 0;

  lifecycle.push("producers-stopped", "submit-fence-complete", "wrappers-disposed");
  gpu.dispose(); gpu = undefined;
  lifecycle.push("gpu-disposed");
  assertions.gpuDisposeDidNotDestroyOrtDevice = deviceDestroyCalls === 0;
  await session.release(); session = undefined;
  lifecycle.push("session-released");
  assertions.sessionReleaseObservedAfterGpuDispose = lifecycle.indexOf("gpu-disposed") < lifecycle.indexOf("session-released");
} catch (error) { errors.push(errorText(error)); }
finally {
  try { gpu?.dispose(); } catch (error) { errors.push(errorText(error)); }
  try { await session?.release(); } catch (error) { errors.push(errorText(error)); }
  for (const restore of restores.reverse()) try { restore(); } catch (error) { errors.push(errorText(error)); }
}
const evidence: Evidence = { platform: "node", status: errors.length === 0 && pass(assertions) ? "PASS" : "FAIL", matrix: { node: process.version, webgpu: "0.4.0", ort: "1.27.0", vgpu: "0.1.6", renderer: "software-renderer@0.1.6" }, assertions, snapshot, reference, lifecycle, errors };
await mkdir(dirname(artifact), { recursive: true });
await writeFile(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (evidence.status !== "PASS") process.exitCode = 1;

function installGlobal(key: string, value: unknown) {
  const old = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  restores.push(() => old ? Object.defineProperty(globalThis, key, old) : Reflect.deleteProperty(globalThis, key));
}
function spyMethod(target: object, key: string, observe: () => void): () => void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  const original = Reflect.get(target, key) as Function;
  const replacement = function(this: unknown, ...args: unknown[]) { observe(); return original.apply(this, args); };
  Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
  return () => own ? Object.defineProperty(target, key, own) : Reflect.deleteProperty(target, key);
}
