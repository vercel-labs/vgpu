import { ValidationError, type Device } from "@vgpu/core";
import type { Mesh } from "../mesh-like.ts";
import type { WireframeMesh } from "./wireframe-mesh.ts";

const EPSILON_SCALE = 1_000_000;
const COPLANAR_DOT = 0.9999;
type Vec3 = readonly [number, number, number];
interface Vertex { readonly position: Vec3; }
interface Edge { readonly a: number; readonly b: number; readonly normals: Vec3[]; }

export async function meshToWireframe(mesh: Mesh, device: Device): Promise<WireframeMesh> {
  const vertices = await meshVertices(mesh);
  const edgeMap = new Map<string, Edge>();
  for (let i = 0; i < mesh.vertexCount; i += 3) {
    const normal = faceNormal(vertices[i].position, vertices[i + 1].position, vertices[i + 2].position);
    visitEdge(i, i + 1, normal, vertices, edgeMap);
    visitEdge(i + 1, i + 2, normal, vertices, edgeMap);
    visitEdge(i + 2, i, normal, vertices, edgeMap);
  }

  const edges = Array.from(edgeMap.values()).filter(shouldKeepEdge);
  const useUint32 = mesh.vertexCount > 65_535;
  const indices = useUint32 ? new Uint32Array(edges.length * 2) : new Uint16Array(edges.length * 2);
  edges.forEach(({ a, b }, index) => { indices[index * 2] = a; indices[index * 2 + 1] = b; });
  const index = device.createBuffer({ label: "meshToWireframe.index", size: indices.byteLength, usage: ["index", "copy_dst"] });
  index.write(indices);
  return Object.freeze({
    vertexBuffer: mesh.vertexBuffer,
    indexBuffer: index.gpu,
    indexFormat: useUint32 ? "uint32" : "uint16",
    lineCount: edges.length,
    attributes: mesh.attributes,
  });
}

async function meshVertices(mesh: Mesh): Promise<Vertex[]> {
  if (!mesh.vertexBuffer.options.usage.includes("copy_src")) throw unreadableMeshError();

  let bytes: ArrayBuffer;
  try {
    bytes = await mesh.vertexBuffer.read(mesh.vertexBuffer.options.size);
  } catch (cause) {
    throw unreadableMeshError(cause);
  }

  const data = new Float32Array(bytes);
  const stride = mesh.attributes.stride / Float32Array.BYTES_PER_ELEMENT;
  const pos = mesh.attributes.position.offset / Float32Array.BYTES_PER_ELEMENT;
  return Array.from({ length: mesh.vertexCount }, (_, i) => ({ position: read3(data, i * stride + pos) }));
}

function visitEdge(a: number, b: number, normal: Vec3, vertices: readonly Vertex[], edgeMap: Map<string, Edge>): void {
  const key = edgeKey(vertices[a].position, vertices[b].position);
  const current = edgeMap.get(key);
  if (current) current.normals.push(normal);
  else edgeMap.set(key, { a, b, normals: [normal] });
}

function shouldKeepEdge(edge: Edge): boolean {
  if (edge.normals.length === 1) return true;
  for (let i = 0; i < edge.normals.length; i++) {
    for (let j = i + 1; j < edge.normals.length; j++) {
      if (dot(edge.normals[i], edge.normals[j]) <= COPLANAR_DOT) return true;
    }
  }
  return false;
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = subtract(b, a);
  const ac = subtract(c, a);
  const n = cross(ab, ac);
  const len = Math.hypot(n[0], n[1], n[2]);
  return len === 0 ? [0, 0, 0] : [n[0] / len, n[1] / len, n[2] / len];
}

function edgeKey(a: Vec3, b: Vec3): string {
  const [first, second] = compare(a, b) <= 0 ? [a, b] : [b, a];
  return `${pointKey(first)}|${pointKey(second)}`;
}

function pointKey(point: Vec3): string {
  return point.map((value) => Math.round(value * EPSILON_SCALE)).join("_");
}

function compare(a: Vec3, b: Vec3): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function read3(data: Float32Array, offset: number): Vec3 {
  return [data[offset], data[offset + 1], data[offset + 2]];
}

function unreadableMeshError(cause?: unknown): ValidationError {
  return new ValidationError({
    code: "VGPU-CORE-INVALID-USAGE",
    message: [
      "meshToWireframe requires the source mesh's vertex buffer to be created with GPUBufferUsage.COPY_SRC.",
      "Mesh.box currently does not satisfy this; create a readable mesh or use a precomputed wireframe.",
    ].join(" "),
    where: "meshToWireframe",
    cause,
  });
}
