// Canonical, reproducible generator for the neural-shader-cppn model.
//
// It writes two artifacts from one seed:
//   public/examples/neural-shader-cppn/model.onnx   the model ORT runs in the browser
//   model-weights.generated.ts                      the same weights for the CPU thumbnail
//
// There is no training and no Python: the ONNX protobuf subset is encoded here
// so the bytes are a pure function of the constants below.
//
// Usage:
//   node generate-model.mjs           write both artifacts
//   node generate-model.mjs --check   regenerate in memory and byte-compare
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, '..', '..');
const modelFile = path.join(docsDir, 'public', 'examples', 'neural-shader-cppn', 'model.onnx');
const hashFile = path.join(docsDir, 'public', 'examples', 'neural-shader-cppn', 'model.sha256');
const weightsFile = path.join(here, 'model-weights.generated.ts');

// ---------------------------------------------------------------------------
// Model specification. Changing anything here changes the committed bytes.
// ---------------------------------------------------------------------------

/** 'CPPN' as ASCII; any 32-bit value works, this one is memorable. */
const SEED = 0x4350504e;
const GRID = 256;
const PIXELS = GRID * GRID;
/** Layer widths: input (x, y, t) -> 24 -> 24 -> 16 -> rgb. */
const LAYERS = { l0: 24, l1: 24, l2: 16, out: 3 };
/**
 * First-layer scales. Space gets high frequencies so the image has fine
 * structure; time gets a small scale so the animation drifts instead of
 * strobing.
 */
const FIRST_LAYER = { spaceScale: 4.75, timeScale: 0.85, biasScale: 1.25 };
/** Hidden/output weights use Xavier bounds; sin layers tolerate a mild boost. */
const HIDDEN_GAIN = 1.75;
const OUTPUT_GAIN = 1.15;

/** xorshift32. Deterministic across engines because every step stays in uint32. */
function createRandom(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

/** Float32Array of `count` values uniform in [-scale, scale), rounded to f32. */
function uniform(random, count, scale) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = Math.fround((random() * 2 - 1) * scale);
  return out;
}

function xavier(fanIn, fanOut, gain) {
  return Math.sqrt(6 / (fanIn + fanOut)) * gain;
}

/**
 * Builds every weight tensor. The generation order is part of the contract:
 * reordering these calls changes the model.
 */
function buildWeights() {
  const random = createRandom(SEED);
  const { l0, l1, l2, out } = LAYERS;

  // Row 0 = x, row 1 = y, row 2 = t, so spatial and temporal frequencies are
  // scaled independently.
  const w0 = new Float32Array(3 * l0);
  for (let unit = 0; unit < l0; unit++) {
    w0[0 * l0 + unit] = Math.fround((random() * 2 - 1) * FIRST_LAYER.spaceScale);
    w0[1 * l0 + unit] = Math.fround((random() * 2 - 1) * FIRST_LAYER.spaceScale);
    w0[2 * l0 + unit] = Math.fround((random() * 2 - 1) * FIRST_LAYER.timeScale);
  }
  const b0 = uniform(random, l0, FIRST_LAYER.biasScale);

  // Each hidden block doubles its width by concatenating sin and tanh.
  const w1 = uniform(random, 2 * l0 * l1, xavier(2 * l0, l1, HIDDEN_GAIN));
  const b1 = uniform(random, l1, 0.35);
  const w2 = uniform(random, 2 * l1 * l2, xavier(2 * l1, l2, HIDDEN_GAIN));
  const b2 = uniform(random, l2, 0.35);
  const w3 = uniform(random, l2 * out, xavier(l2, out, OUTPUT_GAIN));
  const b3 = uniform(random, out, 0.2);

  return {
    w0: { data: w0, dims: [3, l0] },
    b0: { data: b0, dims: [l0] },
    w1: { data: w1, dims: [2 * l0, l1] },
    b1: { data: b1, dims: [l1] },
    w2: { data: w2, dims: [2 * l1, l2] },
    b2: { data: b2, dims: [l2] },
    w3: { data: w3, dims: [l2, out] },
    b3: { data: b3, dims: [out] },
  };
}

// ---------------------------------------------------------------------------
// Minimal ONNX protobuf writer (only the fields this graph needs).
// ---------------------------------------------------------------------------

function varint(value) {
  const bytes = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(bytes);
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const tag = (field, wire) => varint(field * 8 + wire);
/** varint field */
const fInt = (field, value) => concat([tag(field, 0), varint(value)]);
/** length-delimited field */
const fBytes = (field, bytes) => concat([tag(field, 2), varint(bytes.byteLength), bytes]);
const fString = (field, text) => fBytes(field, new TextEncoder().encode(text));

const ELEM_FLOAT = 1;
const ELEM_INT64 = 7;
const ATTR_INT = 2;

function floatTensor(name, dims, data) {
  const source = new Float32Array(data);
  const raw = new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  return concat([
    ...dims.map((dim) => fInt(1, dim)), // dims
    fInt(2, ELEM_FLOAT), // data_type
    fBytes(9, raw), // raw_data
    fString(8, name), // name
  ]);
}

function int64Tensor(name, values) {
  const raw = new Uint8Array(values.length * 8);
  const view = new DataView(raw.buffer);
  values.forEach((value, index) => view.setBigInt64(index * 8, BigInt(value), true));
  return concat([
    fInt(1, values.length), // dims: [n]
    fInt(2, ELEM_INT64),
    fBytes(9, raw),
    fString(8, name),
  ]);
}

function valueInfo(name, elemType, dims) {
  const shape = concat(dims.map((dim) => fBytes(1, fInt(1, dim)))); // Dimension.dim_value
  const tensorType = concat([fInt(1, elemType), fBytes(2, shape)]);
  const type = fBytes(1, tensorType); // TypeProto.tensor_type
  return concat([fString(1, name), fBytes(2, type)]);
}

function node(opType, inputs, outputs, attributes = []) {
  return concat([
    ...inputs.map((name) => fString(1, name)),
    ...outputs.map((name) => fString(2, name)),
    fString(3, `${opType}_${outputs[0]}`), // name
    fString(4, opType),
    ...attributes,
  ]);
}

function attrInt(name, value) {
  return fBytes(5, concat([fString(1, name), fInt(3, value), fInt(20, ATTR_INT)]));
}

/** Encodes the CPPN graph described in the example's plan. */
function encodeModel(weights) {
  const initializers = [
    floatTensor('W0', weights.w0.dims, weights.w0.data),
    floatTensor('B0', weights.b0.dims, weights.b0.data),
    floatTensor('W1', weights.w1.dims, weights.w1.data),
    floatTensor('B1', weights.b1.dims, weights.b1.data),
    floatTensor('W2', weights.w2.dims, weights.w2.data),
    floatTensor('B2', weights.b2.dims, weights.b2.data),
    floatTensor('W3', weights.w3.dims, weights.w3.data),
    floatTensor('B3', weights.b3.dims, weights.b3.data),
    int64Tensor('time_shape', [PIXELS, 1]),
    floatTensor('alpha_seed', [1, 1], [1]),
    int64Tensor('image_shape', [1, GRID, GRID, 4]),
  ];

  const nodes = [
    // time [1,1] -> [PIXELS,1] so the MLP sees (x, y, t) without a CPU upload.
    node('Expand', ['time', 'time_shape'], ['time_grid']),
    node('Concat', ['coords', 'time_grid'], ['xyt'], [attrInt('axis', 1)]),

    node('MatMul', ['xyt', 'W0'], ['m0']),
    node('Add', ['m0', 'B0'], ['z0']),
    node('Sin', ['z0'], ['z0_sin']),
    node('Tanh', ['z0'], ['z0_tanh']),
    node('Concat', ['z0_sin', 'z0_tanh'], ['h0'], [attrInt('axis', 1)]),

    node('MatMul', ['h0', 'W1'], ['m1']),
    node('Add', ['m1', 'B1'], ['z1']),
    node('Sin', ['z1'], ['z1_sin']),
    node('Tanh', ['z1'], ['z1_tanh']),
    node('Concat', ['z1_sin', 'z1_tanh'], ['h1'], [attrInt('axis', 1)]),

    node('MatMul', ['h1', 'W2'], ['m2']),
    node('Add', ['m2', 'B2'], ['z2']),
    node('Sin', ['z2'], ['h2']),

    node('MatMul', ['h2', 'W3'], ['m3']),
    node('Add', ['m3', 'B3'], ['z3']),
    node('Sigmoid', ['z3'], ['rgb']),

    // Opaque alpha, expanded from a 1x1 initializer instead of a 256 KiB constant.
    node('Expand', ['alpha_seed', 'time_shape'], ['alpha']),
    node('Concat', ['rgb', 'alpha'], ['rgba_flat'], [attrInt('axis', 1)]),
    node('Reshape', ['rgba_flat', 'image_shape'], ['rgba']),
  ];

  const graph = concat([
    ...nodes.map((item) => fBytes(1, item)),
    fString(2, 'cppn'),
    ...initializers.map((item) => fBytes(5, item)),
    fBytes(11, valueInfo('coords', ELEM_FLOAT, [PIXELS, 2])),
    fBytes(11, valueInfo('time', ELEM_FLOAT, [1, 1])),
    fBytes(12, valueInfo('rgba', ELEM_FLOAT, [1, GRID, GRID, 4])),
  ]);

  return concat([
    fInt(1, 8), // ir_version 8 pairs with opset 18
    fString(2, 'vgpu-docs/neural-shader-cppn'),
    fString(3, '1.0.0'),
    fBytes(7, graph),
    fBytes(8, concat([fString(1, ''), fInt(2, 18)])), // default domain, opset 18
  ]);
}

// ---------------------------------------------------------------------------
// Generated TypeScript weights for the CPU thumbnail evaluator.
// ---------------------------------------------------------------------------

function formatFloat32Array(name, data) {
  const values = Array.from(data, (value) => String(value));
  const lines = [];
  for (let i = 0; i < values.length; i += 8) lines.push(`  ${values.slice(i, i + 8).join(', ')},`);
  return `export const ${name} = new Float32Array([\n${lines.join('\n')}\n]);\n`;
}

function encodeWeightsModule(weights, sha256) {
  const { l0, l1, l2, out } = LAYERS;
  return `// This file is generated by generate-model.mjs. Do not edit by hand.
// It holds the exact float32 weights baked into
// public/examples/neural-shader-cppn/model.onnx (sha256 ${sha256})
// so the Node thumbnail can evaluate the same network on the CPU.

export const MODEL_SEED = ${SEED};
export const MODEL_SHA256 = '${sha256}';
export const GRID = ${GRID};
export const PIXELS = ${PIXELS};
export const LAYER_SIZES = { l0: ${l0}, l1: ${l1}, l2: ${l2}, out: ${out} } as const;

${formatFloat32Array('W0', weights.w0.data)}
${formatFloat32Array('B0', weights.b0.data)}
${formatFloat32Array('W1', weights.w1.data)}
${formatFloat32Array('B1', weights.b1.data)}
${formatFloat32Array('W2', weights.w2.data)}
${formatFloat32Array('B2', weights.b2.data)}
${formatFloat32Array('W3', weights.w3.data)}
${formatFloat32Array('B3', weights.b3.data)}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const check = process.argv.slice(2).includes('--check');
const weights = buildWeights();
const modelBytes = encodeModel(weights);
const sha256 = createHash('sha256').update(modelBytes).digest('hex');
const weightsModule = encodeWeightsModule(weights, sha256);
const hashLine = `${sha256}  model.onnx\n`;

const kib = modelBytes.byteLength / 1024;
if (kib < 5 || kib > 50) {
  console.error(`Model is ${kib.toFixed(1)} KiB, outside the plausible 5-50 KiB range.`);
  process.exitCode = 1;
} else if (check) {
  const failures = [];
  const onDisk = await readFile(modelFile).catch(() => undefined);
  if (!onDisk) failures.push('public/examples/neural-shader-cppn/model.onnx is missing.');
  else if (Buffer.compare(onDisk, Buffer.from(modelBytes)) !== 0) {
    failures.push('model.onnx does not match the generator output byte-for-byte.');
  }
  const weightsOnDisk = await readFile(weightsFile, 'utf8').catch(() => undefined);
  if (weightsOnDisk !== weightsModule) failures.push('model-weights.generated.ts is stale.');
  const hashOnDisk = await readFile(hashFile, 'utf8').catch(() => undefined);
  if (hashOnDisk !== hashLine) failures.push('model.sha256 is stale.');
  if (failures.length) {
    console.error(`${failures.join('\n')}\nRun \`pnpm --filter docs model:cppn\`.`);
    process.exitCode = 1;
  } else {
    console.log(`model.onnx verified: ${modelBytes.byteLength} bytes, sha256 ${sha256}`);
  }
} else {
  await mkdir(path.dirname(modelFile), { recursive: true });
  await writeFile(modelFile, modelBytes);
  await writeFile(hashFile, hashLine);
  await writeFile(weightsFile, weightsModule);
  console.log(`Wrote model.onnx (${modelBytes.byteLength} bytes, ${kib.toFixed(1)} KiB), sha256 ${sha256}`);
}
