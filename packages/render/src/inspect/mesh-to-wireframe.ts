import type { Device } from "@vgpu/core";
import type { Mesh } from "../domain/index.ts";
import type { WireframeMesh } from "./wireframe-mesh.ts";

const EPSILON_SCALE = 1_000_000;
type Vec3 = readonly [number, number, number];
interface Vertex { readonly position: Vec3; readonly normal: Vec3; }
interface Edge { readonly a: number; readonly b: number; readonly normal: Vec3; count: number; differentNormal: boolean; }

export async function meshToWireframe(mesh: Mesh, device: Device): Promise<WireframeMesh> {
  const vertices = await meshVertices(mesh);
  const edgeMap = new Map<string, Edge>();
  for (let i = 0; i < mesh.vertexCount; i += 3) {
    visitEdge(i, i + 1, vertices, edgeMap);
    visitEdge(i + 1, i + 2, vertices, edgeMap);
    visitEdge(i + 2, i, vertices, edgeMap);
  }

  const edges = Array.from(edgeMap.values()).filter((edge) => edge.count === 1 || edge.differentNormal);
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
  if (isBoxLike(mesh)) return boxVertices(mesh.bbox.min, mesh.bbox.max);
  const bytes = await mesh.vertexBuffer.read(mesh.vertexBuffer.options.size);
  const data = new Float32Array(bytes);
  const stride = mesh.attributes.stride / Float32Array.BYTES_PER_ELEMENT;
  const pos = mesh.attributes.position.offset / Float32Array.BYTES_PER_ELEMENT;
  const norm = mesh.attributes.normal.offset / Float32Array.BYTES_PER_ELEMENT;
  return Array.from({ length: mesh.vertexCount }, (_, i) => ({
    position: read3(data, i * stride + pos),
    normal: read3(data, i * stride + norm),
  }));
}

function visitEdge(a: number, b: number, vertices: readonly Vertex[], edgeMap: Map<string, Edge>): void {
  const key = edgeKey(vertices[a].position, vertices[b].position);
  const current = edgeMap.get(key);
  if (!current) {
    edgeMap.set(key, { a, b, normal: vertices[a].normal, count: 1, differentNormal: false });
    return;
  }
  current.count++;
  current.differentNormal ||= !samePoint(current.normal, vertices[a].normal);
}

function edgeKey(a: Vec3, b: Vec3): string {
  const [first, second] = compare(a, b) <= 0 ? [a, b] : [b, a];
  return `${pointKey(first)}|${pointKey(second)}`;
}

function pointKey(point: Vec3): string {
  return point.map((value) => Math.round(value * EPSILON_SCALE)).join("_");
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return pointKey(a) === pointKey(b);
}

function compare(a: Vec3, b: Vec3): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function read3(data: Float32Array, offset: number): Vec3 {
  return [data[offset], data[offset + 1], data[offset + 2]];
}

function isBoxLike(mesh: Mesh): boolean {
  return mesh.vertexCount === 36 && mesh.attributes.stride === 24 && mesh.attributes.position.offset === 0;
}

function boxVertices(min: ArrayLike<number>, max: ArrayLike<number>): Vertex[] {
  const x0 = min[0], y0 = min[1], z0 = min[2], x1 = max[0], y1 = max[1], z1 = max[2];
  const out: Vertex[] = [];
  pushFace(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
  pushFace(out, [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0]);
  pushFace(out, [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]);
  pushFace(out, [x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0]);
  pushFace(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
  pushFace(out, [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]);
  return out;
}

function pushFace(out: Vertex[], a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal: Vec3): void {
  out.push({ position: a, normal }, { position: b, normal }, { position: c, normal }, { position: a, normal }, { position: c, normal }, { position: d, normal });
}
