import { readFile } from "node:fs/promises";
import { create, globals } from "webgpu";

const [sourcePath, reflectionPath, label] = process.argv.slice(2);
if (!sourcePath || !reflectionPath || !label) {
  throw new Error("usage: tint-child.mjs <source.wgsl> <reflection.json> <label>");
}
const [code, reflectionSource] = await Promise.all([readFile(sourcePath, "utf8"), readFile(reflectionPath, "utf8")]);
const reflection = JSON.parse(reflectionSource);

Object.assign(globalThis, globals);
let gpu;
let device;
const result = { label, moduleDiagnostics: [], pipelines: [] };

const scalarFormat = (name) => ({ f32: "float32", i32: "sint32", u32: "uint32" })[name];
function vertexFormat(type) {
  if (type?.kind === "scalar") return scalarFormat(type.name);
  if (type?.kind === "vector") {
    const scalar = scalarFormat(type.element?.name);
    return scalar && type.width >= 2 && type.width <= 4 ? `${scalar}x${type.width}` : undefined;
  }
  return undefined;
}

function vertexBuffers(entry) {
  let offset = 0;
  const attributes = [];
  for (const input of entry.inputs ?? []) {
    const format = vertexFormat(input.type);
    if (!format) throw new Error(`unsupported vertex input at location ${input.location}: ${JSON.stringify(input.type)}`);
    const bytes = input.type.kind === "scalar" ? 4 : input.type.width * 4;
    attributes.push({ shaderLocation: input.location, offset, format });
    offset += bytes;
  }
  return attributes.length ? [{ arrayStride: Math.max(4, Math.ceil(offset / 4) * 4), attributes }] : [];
}

function matchingIndex(source, start, open, close) {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    if (source[index] === open) depth++;
    else if (source[index] === close && --depth === 0) return index;
  }
  throw new Error(`unclosed ${open} at ${start}`);
}

function entryDeclaration(name, stage) {
  const expression = new RegExp(`@${stage}\\b[\\s\\S]*?\\bfn\\s+${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*\\(`, "g");
  const match = expression.exec(code);
  if (!match) throw new Error(`cannot locate ${stage} entry ${name}`);
  const paramsStart = code.indexOf("(", match.index + match[0].lastIndexOf("fn"));
  const paramsEnd = matchingIndex(code, paramsStart, "(", ")");
  const bodyStart = code.indexOf("{", paramsEnd);
  const returnText = code.slice(paramsEnd + 1, bodyStart).replace(/^\s*->\s*/, "").trim();
  return { params: code.slice(paramsStart + 1, paramsEnd), returnText };
}

function structBody(name) {
  const expression = new RegExp(`\\bstruct\\s+${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*\\{`, "g");
  const match = expression.exec(code);
  if (!match) return undefined;
  const start = code.indexOf("{", match.index);
  return code.slice(start + 1, matchingIndex(code, start, "{", "}"));
}

function locationDeclarations(source) {
  const declarations = [];
  const expression = /((?:@[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*)+)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,}\n]+)/g;
  for (const match of source.matchAll(expression)) {
    const location = /@location\s*\(\s*(\d+)\s*\)/.exec(match[1]);
    if (!location) continue;
    declarations.push({
      location: Number(location[1]),
      name: match[2],
      type: match[3].trim(),
      interpolation: /@interpolate\s*\([^)]*\)/.exec(match[1])?.[0],
    });
  }
  return declarations;
}

function splitTopLevel(source) {
  const parts = [];
  let start = 0;
  let parens = 0;
  let angles = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "(") parens++;
    else if (source[index] === ")") parens--;
    else if (source[index] === "<") angles++;
    else if (source[index] === ">") angles--;
    else if (source[index] === "," && parens === 0 && angles === 0) {
      parts.push(source.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

function fragmentInputs(entry) {
  const { params } = entryDeclaration(entry.mangledName, "fragment");
  const direct = locationDeclarations(params);
  for (const parameter of splitTopLevel(params)) {
    if (/@(?:location|builtin)\s*\(/.test(parameter)) continue;
    const type = /:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(parameter)?.[1];
    const body = type && structBody(type);
    if (body) direct.push(...locationDeclarations(body));
  }
  return [...new Map(direct.map((item) => [item.location, item])).values()].sort((a, b) => a.location - b.location);
}

function fragmentOutputs(entry) {
  const { returnText } = entryDeclaration(entry.mangledName, "fragment");
  const direct = /@location\s*\(\s*(\d+)\s*\)\s*([^\s{]+)/.exec(returnText);
  if (direct) return [{ location: Number(direct[1]), type: direct[2].trim() }];
  const type = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(returnText)?.[1];
  const body = type && structBody(type);
  return body ? locationDeclarations(body) : [];
}

function dummyVertexSource(inputs) {
  const needsF16 = inputs.some((input) => /(?:f16|[234]h)\b/.test(input.type));
  const fields = inputs.map((input) => `  @location(${input.location})${input.interpolation ? ` ${input.interpolation}` : ""} value_${input.location}: ${input.type},`).join("\n");
  const assignments = inputs.map((input) => `  out.value_${input.location} = ${input.type}(0);`).join("\n");
  return `${needsF16 ? "enable f16;\n" : ""}struct VGPUC1DummyOut {\n  @builtin(position) position: vec4f,\n${fields}\n}\n@vertex fn vgpu_c1_dummy_vs(@builtin(vertex_index) i: u32) -> VGPUC1DummyOut {\n  var out: VGPUC1DummyOut;\n  out.position = vec4f(f32(i & 1u) * 2.0 - 1.0, f32((i >> 1u) & 1u) * 2.0 - 1.0, 0.0, 1.0);\n${assignments}\n  return out;\n}`;
}

function targetFormat(type) {
  const compact = type.replaceAll(/\s/g, "");
  const scalar = compact.match(/^(f32|u32|i32)$/)?.[1];
  const vector = compact.match(/^vec([234])(?:<)?(f32|u32|i32)>?$/) ?? compact.match(/^vec([234])([fui])$/);
  const width = scalar ? 1 : Number(vector?.[1]);
  const kind = scalar ?? (vector?.[2] === "f" ? "f32" : vector?.[2] === "u" ? "u32" : vector?.[2] === "i" ? "i32" : vector?.[2]);
  const prefix = kind === "f32" ? "float" : kind === "u32" ? "uint" : kind === "i32" ? "sint" : undefined;
  if (!prefix || ![1, 2, 4].includes(width)) throw new Error(`unsupported fragment output type ${type}`);
  return `${width === 1 ? "r32" : width === 2 ? "rg32" : "rgba32"}${prefix}`;
}

function fragmentTargets(entry) {
  const outputs = fragmentOutputs(entry);
  if (!outputs.length) return [];
  const targets = Array.from({ length: Math.max(...outputs.map((output) => output.location)) + 1 }, () => null);
  for (const output of outputs) targets[output.location] = { format: targetFormat(output.type), writeMask: 0 };
  return targets;
}

async function scopedPipeline(label, createPipeline) {
  console.error(`__VGPU_C1_ENTRY_BEGIN__${JSON.stringify({ label })}`);
  device.pushErrorScope("validation");
  let thrown;
  try {
    await createPipeline();
  } catch (error) {
    thrown = error?.message ?? String(error);
  }
  const scoped = await device.popErrorScope();
  const record = { label, ok: !thrown && !scoped, thrown, scoped: scoped?.message };
  result.pipelines.push(record);
  console.error(`__VGPU_C1_ENTRY_END__${JSON.stringify(record)}`);
}

try {
  const enabledDawnFeatures = ["dump_shaders"];
  if (process.env.C1_TINT_DISABLE_SYMBOL_RENAMING === "1") enabledDawnFeatures.push("disable_symbol_renaming");
  gpu = create(["backend=metal", `enable-dawn-features=${enabledDawnFeatures.join(",")}`]);
  result.wgslLanguageFeatures = [...gpu.wgslLanguageFeatures].sort();
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("Dawn returned no Metal adapter");
  device = await adapter.requestDevice({
    requiredLimits: {
      maxColorAttachments: adapter.limits.maxColorAttachments,
      maxColorAttachmentBytesPerSample: adapter.limits.maxColorAttachmentBytesPerSample,
      maxVertexAttributes: adapter.limits.maxVertexAttributes,
    },
  });
  const module = device.createShaderModule({ code });
  const compilation = await module.getCompilationInfo();
  result.moduleDiagnostics = [...compilation.messages].map((message) => ({
    type: message.type,
    message: message.message,
    lineNum: message.lineNum,
    linePos: message.linePos,
    offset: message.offset,
    length: message.length,
  }));

  const compute = reflection.entryPoints.filter((entry) => entry.stage === "compute");
  const vertices = reflection.entryPoints.filter((entry) => entry.stage === "vertex");
  const fragments = reflection.entryPoints.filter((entry) => entry.stage === "fragment");
  for (const entry of compute) {
    await scopedPipeline(`compute:${entry.mangledName}`, () => device.createComputePipelineAsync({
      layout: "auto",
      compute: { module, entryPoint: entry.mangledName },
    }));
  }

  const renderPairs = [];
  if (vertices.length) {
    for (const vertex of vertices) renderPairs.push({ vertex, fragment: fragments[0] });
    for (const fragment of fragments.slice(1)) renderPairs.push({ vertex: vertices[0], fragment });
  } else {
    for (const fragment of fragments) renderPairs.push({ vertex: undefined, fragment });
  }
  for (const pair of renderPairs) {
    const vertexLabel = pair.vertex?.mangledName ?? "vgpu_c1_dummy_vs";
    const fragmentLabel = pair.fragment?.mangledName ?? "none";
    const dummyVertexModule = pair.vertex ? undefined : device.createShaderModule({ code: dummyVertexSource(fragmentInputs(pair.fragment)) });
    await scopedPipeline(`render:${vertexLabel}+${fragmentLabel}`, () => device.createRenderPipelineAsync({
      layout: "auto",
      vertex: {
        module: pair.vertex ? module : dummyVertexModule,
        entryPoint: vertexLabel,
        buffers: pair.vertex ? vertexBuffers(pair.vertex) : [],
      },
      ...(pair.fragment ? {
        fragment: {
          module,
          entryPoint: pair.fragment.mangledName,
          targets: fragmentTargets(pair.fragment),
        },
      } : {}),
      primitive: { topology: "triangle-list" },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
    }));
  }
  result.ok = result.moduleDiagnostics.every((message) => message.type !== "error") && result.pipelines.every((pipeline) => pipeline.ok);
} catch (error) {
  result.ok = false;
  result.fatal = { name: error?.name, message: error?.message ?? String(error), stack: error?.stack };
} finally {
  device?.destroy();
}

process.stdout.write(`__VGPU_C1_RESULT__${JSON.stringify(result)}\n`);
process.exit(result.ok ? 0 : 1);
