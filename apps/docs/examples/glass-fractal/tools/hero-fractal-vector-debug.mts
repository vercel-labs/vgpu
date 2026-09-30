#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareShader } from "@vgpu/wgsl/prepare";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { PNG } from "pngjs";
import { draw, frame, geometry, init, target } from "vgpu/node";
import { perspectiveCamera } from "vgpu/scene";

type DebugMode = "normal" | "diffuse-environment" | "environment";

interface DebugOptions {
  readonly outDir: string;
  readonly size: readonly [number, number];
  readonly environmentRotation: readonly [number, number, number];
  readonly sphereMix: number;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_DIR = resolve(HERE, "..");
const FRACTAL_MESH_PATH = resolve(
  HERE,
  "../../../public/examples/glass-fractal/fractal-tetrahedron-l7.mesh"
);
const DEBUG_SHADER_PATH = resolve(
  EXAMPLE_DIR,
  "hero-fractal-vector-debug.wgsl"
);
const DEFAULT_OUT_DIR = join(tmpdir(), "vgpu-hero-vector-debug");
const MESH_HEADER_SIZE = 40;

// Mirrors the current centered hero composition. Change these alongside the
// hero constants when investigating a particular camera arrangement.
const CAMERA_POSITION = [5.36, 1.49, 1.29] as const;
const CAMERA_TARGET = [-0.08, 0.16, 0.74] as const;
const CAMERA_FOV = 17.3;
const FRACTAL_SCALE = 0.59;

const options = parseArgs(process.argv.slice(2));
await mkdir(options.outDir, { recursive: true });

const gpu = await init();
const gpuErrors: unknown[] = [];
const unsubscribe = gpu.onError((error) => gpuErrors.push(error));
const output = target(gpu, {
  size: options.size,
  format: "rgba8unorm",
  depth: true,
  label: "hero-fractal-vector-debug",
});
const mesh = await decodeFractalMesh();

try {
  const shader = await resolveShader({
    entry: DEBUG_SHADER_PATH,
    rootDir: EXAMPLE_DIR,
    validate: false,
  });
  const drawable = draw(gpu, {
    shader: prepareShader(shader, DEBUG_SHADER_PATH),
    geometry: mesh.geometry,
    instances: 4,
    cull: "back",
    label: "hero-fractal-vector-debug",
  });
  const camera = perspectiveCamera({
    fov: CAMERA_FOV,
    aspect: options.size[0] / options.size[1],
    near: 0.05,
    far: 20,
    position: CAMERA_POSITION,
    target: CAMERA_TARGET,
  });

  await drawable.compile(output);
  const modes: readonly DebugMode[] = [
    "normal",
    "diffuse-environment",
    "environment",
  ];
  for (const mode of modes) {
    drawable.set({
      params: {
        viewProjection: camera.viewProjection,
        model: scaleMatrix(FRACTAL_SCALE),
        cameraPosition: CAMERA_POSITION,
        meshMin: mesh.meshMin,
        meshMax: mesh.meshMax,
        sphereMix: options.sphereMix,
        time: 0,
        environmentRotation: environmentRotationMatrix(
          options.environmentRotation
        ),
        mode:
          mode === "environment" ? 2 : mode === "diffuse-environment" ? 1 : 0,
      },
    });
    frame(gpu, (currentFrame) => {
      currentFrame.pass(
        { target: output, clear: [250 / 255, 250 / 255, 250 / 255, 1] },
        (pass) => pass.draw(drawable)
      );
    });
    await gpu.gpu.queue.onSubmittedWorkDone();
    await gpu.settled();
    const path = join(options.outDir, `${mode}.png`);
    await writePng(
      path,
      options.size,
      await output.color.read({ mipLevel: 0, region: "all" })
    );
    console.log(path);
  }

  if (gpuErrors.length > 0) {
    throw new AggregateError(gpuErrors, "WebGPU reported vector-debug errors");
  }
  console.log(
    "RGB decoding: direction = rgb / 127.5 - 1; diffuse-environment encodes the rotated normal lookup and environment encodes the rotated reflection lookup."
  );
} finally {
  unsubscribe();
  mesh.geometry.destroy();
  (output as typeof output & { destroy?: () => void }).destroy?.();
  gpu.dispose();
}

function parseArgs(argv: readonly string[]): DebugOptions {
  let outDir = DEFAULT_OUT_DIR;
  let size: readonly [number, number] = [960, 720];
  let environmentRotation: readonly [number, number, number] = [0, 0, 0];
  let sphereMix = 0;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--out") {
      outDir = resolve(argv[++index] ?? "");
    } else if (token === "--size") {
      const values = (argv[++index] ?? "").split("x").map(Number);
      if (
        values.length !== 2 ||
        values.some((value) => !Number.isFinite(value))
      ) {
        throw new Error("--size expects WIDTHxHEIGHT");
      }
      size = [
        Math.max(1, Math.floor(values[0])),
        Math.max(1, Math.floor(values[1])),
      ];
    } else if (token === "--environment-rotation") {
      const values = (argv[++index] ?? "").split(",").map(Number);
      if (
        values.length !== 3 ||
        values.some((value) => !Number.isFinite(value))
      ) {
        throw new Error("--environment-rotation expects X,Y,Z in degrees");
      }
      environmentRotation = [values[0], values[1], values[2]];
    } else if (token === "--sphere-mix") {
      const value = Number(argv[++index] ?? "");
      if (!Number.isFinite(value)) {
        throw new Error("--sphere-mix expects a number from 0 to 1");
      }
      sphereMix = Math.min(1, Math.max(0, value));
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return { outDir, size, environmentRotation, sphereMix };
}

async function decodeFractalMesh() {
  const bytes = await readFile(FRACTAL_MESH_PATH);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  if (buffer.byteLength < MESH_HEADER_SIZE) {
    throw new Error("Hero fractal mesh header is truncated.");
  }
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== "HGP2")
    throw new Error("Unsupported hero fractal mesh format.");
  const vertexCount = view.getUint32(4, true);
  const indexCount = view.getUint32(8, true);
  const stride = view.getUint32(12, true);
  if (stride !== 24 || vertexCount <= 0 || indexCount <= 0) {
    throw new Error("Hero fractal mesh layout is invalid.");
  }
  const meshMin = [
    view.getFloat32(16, true),
    view.getFloat32(20, true),
    view.getFloat32(24, true),
  ] as const;
  const meshMax = [
    view.getFloat32(28, true),
    view.getFloat32(32, true),
    view.getFloat32(36, true),
  ] as const;
  const vertexEnd = MESH_HEADER_SIZE + vertexCount * stride;
  if (vertexEnd + indexCount * 2 !== buffer.byteLength) {
    throw new Error("Hero fractal mesh payload length is invalid.");
  }
  const vertexData = new Uint8Array(buffer.slice(MESH_HEADER_SIZE, vertexEnd));
  const indices = new Uint16Array(buffer.slice(vertexEnd));
  return {
    geometry: geometry(gpu, {
      label: "hero-fractal-vector-debug-mesh",
      buffers: [
        {
          data: vertexData,
          stride,
          attributes: {
            packed_position: "unorm16x4" as const,
            packed_normal: "snorm16x4" as const,
            packed_sphere: "snorm16x4" as const,
          },
        },
      ],
      indices,
    }),
    meshMin,
    meshMax,
  };
}

async function writePng(
  path: string,
  size: readonly [number, number],
  pixels: Uint8Array
): Promise<void> {
  const png = new PNG({ width: size[0], height: size[1] });
  png.data.set(pixels);
  await writeFile(path, PNG.sync.write(png));
}

function scaleMatrix(scale: number): Float32Array {
  return new Float32Array([
    scale,
    0,
    0,
    0,
    0,
    scale,
    0,
    0,
    0,
    0,
    scale,
    0,
    0,
    0,
    0,
    1,
  ]);
}

function environmentRotationMatrix(
  rotationDegrees: readonly [number, number, number]
): Float32Array {
  const toRadians = -Math.PI / 180;
  const [x, y, z] = rotationDegrees.map((value) => value * toRadians);
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  return new Float32Array([
    cz * cy,
    sz * cy,
    -sy,
    0,
    cz * sy * sx - sz * cx,
    sz * sy * sx + cz * cx,
    cy * sx,
    0,
    cz * sy * cx + sz * sx,
    sz * sy * cx - cz * sx,
    cy * cx,
    0,
    0,
    0,
    0,
    1,
  ]);
}
