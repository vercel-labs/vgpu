import * as ort from "onnxruntime-web/webgpu";
import { initFromDevice } from "vgpu";
import { DIMS, INPUT, MODEL_FILE, verifyModel } from "../shared/fixtures.ts";
import { errorText, pass, type Evidence } from "../shared/evidence.ts";
import { runPipeline, type Mode } from "../shared/pipeline.ts";

const assertions: Record<string, boolean> = {};
const errors: string[] = [], lifecycle: string[] = [];
let session: ort.InferenceSession | undefined, gpu: Awaited<ReturnType<typeof initFromDevice>> | undefined;
let snapshot: unknown, reference: unknown, deviceDestroyCalls = 0, rawDestroyCalls = 0;
const restores: Array<() => void> = [];
try {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("requestAdapter returned null");
  ort.env.webgpu.adapter = adapter;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = "/ort/";
  const response = await fetch(`/fixtures/models/${MODEL_FILE}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`model fetch HTTP ${response.status}`);
  const modelBytes = new Uint8Array(await response.arrayBuffer());
  await verifyModel(modelBytes);
  session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["webgpu"], preferredOutputLocation: "gpu-buffer" });
  const rawDevice = await ort.env.webgpu.device;
  if (!rawDevice) throw new Error("ORT WebGPU device absent");
  restores.push(spyMethod(rawDevice, "destroy", () => deviceDestroyCalls++));
  gpu = await initFromDevice(rawDevice);
  assertions.deviceIdentity = gpu.gpu === rawDevice && gpu.device.gpu === rawDevice;

  const runMode = async (mode: Mode) => {
    const input = new ort.Tensor("float32", INPUT, [...DIMS]); let output: ort.Tensor | undefined;
    try {
      const outputs = await session!.run({ input }); output = outputs.output ?? outputs[session!.outputNames[0]!]!;
      const raw = output.gpuBuffer;
      if (!raw) throw new Error(`${mode}: GPU output absent (anti-CPU-fallback gate)`);
      const restore = spyMethod(raw, "destroy", () => rawDestroyCalls++);
      try { return await runPipeline(gpu!, raw, mode); } finally { restore(); }
    } finally { input.dispose(); output?.dispose(); lifecycle.push(`${mode}-tensor-disposed-after-flush-and-wrapper`); }
  };
  snapshot = await runMode("snapshot"); reference = await runMode("reference");
  assertions.snapshotNumeric = (snapshot as any).numericMatch;
  assertions.referenceNumeric = (reference as any).numericMatch;
  assertions.snapshotOneCopy = (snapshot as any).copyCount === 1;
  assertions.referenceZeroCopy = (reference as any).copyCount === 0;
  assertions.referenceRawIdentity = (reference as any).rawIdentity;
  assertions.antiCpuFallback = true;
  assertions.wrapperDidNotDestroyRaw = rawDestroyCalls === 0;
  lifecycle.push("producers-stopped", "submit-fence-complete", "wrappers-disposed");
  gpu.dispose(); gpu = undefined; lifecycle.push("gpu-disposed");
  assertions.gpuDisposeDidNotDestroyOrtDevice = deviceDestroyCalls === 0;
  await session.release(); session = undefined; lifecycle.push("session-released");
  assertions.teardownOrder = lifecycle.indexOf("gpu-disposed") < lifecycle.indexOf("session-released");
} catch (error) { errors.push(errorText(error)); }
finally {
  try { gpu?.dispose(); } catch (error) { errors.push(errorText(error)); }
  try { await session?.release(); } catch (error) { errors.push(errorText(error)); }
  for (const restore of restores.reverse()) try { restore(); } catch (error) { errors.push(errorText(error)); }
}
let evidence: Evidence = { platform: "browser", status: errors.length === 0 && pass(assertions) ? "PASS" : "FAIL", matrix: { browser: navigator.userAgent, ort: "1.27.0", vgpu: "0.1.6", renderer: "agent-browser SwiftShader --webgpu --headed" }, assertions, snapshot, reference, lifecycle, errors };
draw((reference as any)?.actual ?? []);
try {
  const saved = await fetch("/evidence/browser", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(evidence) });
  if (!saved.ok) throw new Error(`evidence write HTTP ${saved.status}: ${await saved.text()}`);
  const check = await saved.json(); assertions.artifactPersisted = check.exists && check.byteLength > 0;
  evidence = { ...evidence, status: errors.length === 0 && pass(assertions) ? "PASS" : "FAIL", assertions };
  await fetch("/evidence/browser", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(evidence) });
} catch (error) { errors.push(errorText(error)); evidence = { ...evidence, status: "FAIL", errors }; }
const result = document.querySelector("#result")!; result.textContent = JSON.stringify(evidence, null, 2);
document.querySelector("#summary")!.textContent = `${evidence.status}: real ORT WebGPU snapshot + reference`;
document.documentElement.dataset.probeStatus = evidence.status;
document.title = evidence.status === "PASS" ? "PROBE_PASS" : "PROBE_FAIL";
function draw(values: number[]) { const canvas = document.querySelector("canvas")!; const c = canvas.getContext("2d")!; c.fillStyle="#06111d"; c.fillRect(0,0,640,220); values.forEach((v,i)=>{c.fillStyle=`hsl(${190-v*55} 90% 60%)`; c.fillRect(i*39+8,205-v*75,28,v*75);}); }
function spyMethod(target: object, key: string, observe: () => void) { const own=Object.getOwnPropertyDescriptor(target,key); const original=Reflect.get(target,key) as Function; Object.defineProperty(target,key,{configurable:true,writable:true,value:function(this:unknown,...args:unknown[]){observe();return original.apply(this,args);}}); return ()=>own?Object.defineProperty(target,key,own):Reflect.deleteProperty(target,key); }
