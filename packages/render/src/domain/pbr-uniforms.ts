import { invalidUsage } from "../uniform-pool-internals.ts";
import type { DirectionalLight, MaterialParams } from "./material.ts";
import {
  UNIFORM_OFFSET_BASE_COLOR,
  UNIFORM_OFFSET_CAMERA_POSITION,
  UNIFORM_OFFSET_LIGHT_COLOR,
  UNIFORM_OFFSET_LIGHT_DIRECTION,
  UNIFORM_OFFSET_LIGHT_INTENSITY,
  UNIFORM_OFFSET_METALLIC,
  UNIFORM_OFFSET_MODEL,
  UNIFORM_OFFSET_ROUGHNESS,
  UNIFORM_OFFSET_VIEW_PROJECTION,
  UNIFORMS_BYTE_SIZE,
} from "./pbr-shader.ts";
import type { Mat4, Vec3 } from "./camera.ts";

export interface PbrUniformValues {
  readonly viewProjection: Mat4;
  readonly model: Mat4;
  readonly cameraPosition: Vec3 | readonly [number, number, number];
  readonly light: DirectionalLight;
  readonly baseColor?: readonly [number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
}

const VIEW_PROJ = UNIFORM_OFFSET_VIEW_PROJECTION / Float32Array.BYTES_PER_ELEMENT;
const MODEL = UNIFORM_OFFSET_MODEL / Float32Array.BYTES_PER_ELEMENT;
const CAMERA = UNIFORM_OFFSET_CAMERA_POSITION / Float32Array.BYTES_PER_ELEMENT;
const LIGHT_DIRECTION = UNIFORM_OFFSET_LIGHT_DIRECTION / Float32Array.BYTES_PER_ELEMENT;
const LIGHT_COLOR = UNIFORM_OFFSET_LIGHT_COLOR / Float32Array.BYTES_PER_ELEMENT;
const LIGHT_INTENSITY = UNIFORM_OFFSET_LIGHT_INTENSITY / Float32Array.BYTES_PER_ELEMENT;
const BASE_COLOR = UNIFORM_OFFSET_BASE_COLOR / Float32Array.BYTES_PER_ELEMENT;
const METALLIC = UNIFORM_OFFSET_METALLIC / Float32Array.BYTES_PER_ELEMENT;
const ROUGHNESS = UNIFORM_OFFSET_ROUGHNESS / Float32Array.BYTES_PER_ELEMENT;
const REQUIRED = ["viewProjection", "model", "cameraPosition", "light"] as const;
const OPTIONAL = new Set(["baseColor", "metallic", "roughness"]);

export function pbrUniformBytes(uniforms: PbrUniformValues, params: MaterialParams): Float32Array<ArrayBuffer> {
  validate(uniforms);
  const light = uniforms.light;
  const out = new Float32Array(UNIFORMS_BYTE_SIZE / Float32Array.BYTES_PER_ELEMENT);
  out.set(uniforms.viewProjection, VIEW_PROJ);
  out.set(uniforms.model, MODEL);
  write3(out, CAMERA, uniforms.cameraPosition);
  writeNormalized3(out, LIGHT_DIRECTION, light.direction);
  write3(out, LIGHT_COLOR, light.color);
  out[LIGHT_INTENSITY] = light.intensity;
  write3(out, BASE_COLOR, uniforms.baseColor ?? params.baseColor);
  out[METALLIC] = uniforms.metallic ?? params.metallic;
  out[ROUGHNESS] = uniforms.roughness ?? params.roughness;
  return out;
}

function validate(values: PbrUniformValues): void {
  const keys = new Set(Object.keys(values));
  for (const key of REQUIRED) {
    if (!keys.delete(key)) throw invalidUsage("pbrMaterial.writeUniforms", `Missing uniform '${key}'.`);
  }
  for (const key of [...keys]) if (OPTIONAL.has(key)) keys.delete(key);
  const extra = keys.values().next().value as string | undefined;
  if (extra) throw invalidUsage("pbrMaterial.writeUniforms", `Unknown uniform '${extra}'.`);
}

function write3(out: Float32Array, offset: number, value: Vec3 | readonly [number, number, number]): void {
  out[offset] = value[0]; out[offset + 1] = value[1]; out[offset + 2] = value[2];
}

function writeNormalized3(out: Float32Array, offset: number, value: Vec3 | readonly [number, number, number]): void {
  const x = value[0], y = value[1], z = value[2], length = Math.hypot(x, y, z) || 1;
  out[offset] = x / length; out[offset + 1] = y / length; out[offset + 2] = z / length;
}
