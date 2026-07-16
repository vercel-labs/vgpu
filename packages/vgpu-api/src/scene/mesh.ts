import type { Device } from "@vgpu/core";
import {
  box as renderBox,
  capsule as renderCapsule,
  cone as renderCone,
  cylinder as renderCylinder,
  disk as renderDisk,
  dodecahedron as renderDodecahedron,
  fullscreenQuad as renderFullscreenQuad,
  icosahedron as renderIcosahedron,
  icosphere as renderIcosphere,
  octahedron as renderOctahedron,
  plane as renderPlane,
  ring as renderRing,
  sphere as renderSphere,
  tetrahedron as renderTetrahedron,
  torus as renderTorus,
  type MeshPrimitive,
  type VertexAttributes,
} from "./geometry-src/index.ts";
import type { MeshLike } from "../draw.ts";
import type { SceneGeometry } from "./geometry.ts";

export type SceneMesh = MeshLike;

type MeshFactory = (device: Device, geometry: SceneGeometry) => MeshPrimitive;

const meshFactories: { readonly [K in SceneGeometry["kind"]]: MeshFactory } = {
  box: (device, geometry) => renderBox({ device, ...geometry.props }),
  capsule: (device, geometry) => renderCapsule({ device, radius: 0.5, height: 1, ...geometry.props }),
  cone: (device, geometry) => renderCone({ device, radius: 0.5, height: 1, ...geometry.props }),
  cylinder: (device, geometry) => renderCylinder({ device, radius: 0.5, height: 1, ...geometry.props }),
  disk: (device, geometry) => renderDisk({ device, radius: 0.5, ...geometry.props }),
  dodecahedron: (device, geometry) => renderDodecahedron({ device, radius: 0.5, ...geometry.props }),
  fullscreenQuad: (device, geometry) => renderFullscreenQuad({ device, ...geometry.props }),
  icosahedron: (device, geometry) => renderIcosahedron({ device, radius: 0.5, ...geometry.props }),
  icosphere: (device, geometry) => renderIcosphere({ device, radius: 0.5, ...geometry.props }),
  octahedron: (device, geometry) => renderOctahedron({ device, radius: 0.5, ...geometry.props }),
  plane: (device, geometry) => renderPlane({ device, ...geometry.props }),
  ring: (device, geometry) => renderRing({ device, innerRadius: 0.25, outerRadius: 0.5, ...geometry.props }),
  sphere: (device, geometry) => renderSphere({ device, ...geometry.props }),
  tetrahedron: (device, geometry) => renderTetrahedron({ device, radius: 0.5, ...geometry.props }),
  torus: (device, geometry) => renderTorus({ device, radius: 0.5, tube: 0.2, ...geometry.props }),
};

/** Converts a pure scene geometry descriptor into the vertex/index buffer contract consumed by gpu.draw(). */
export function mesh(device: Device, geometry: SceneGeometry): SceneMesh {
  const primitive = primitiveMesh(device, geometry);
  return Object.freeze({
    vertexCount: primitive.vertexCount,
    indexCount: primitive.indexCount,
    vertexBuffers: [primitive.gpu?.vertexBuffer ?? primitive.vertexBuffer.gpu],
    indexBuffer: primitive.gpu?.indexBuffer ?? primitive.indexBuffer?.gpu,
    indexFormat: primitive.indexFormat,
    vertexBufferLayouts: [vertexBufferLayout(primitive.attributes)],
  });
}

function primitiveMesh(device: Device, geometry: SceneGeometry): MeshPrimitive {
  return meshFactories[geometry.kind](device, geometry);
}

function vertexBufferLayout(attributes: VertexAttributes): GPUVertexBufferLayout {
  return {
    arrayStride: attributes.stride,
    attributes: vertexAttributes(attributes),
  };
}

function vertexAttributes(attributes: VertexAttributes): GPUVertexAttribute[] {
  const entries: GPUVertexAttribute[] = [attribute(0, attributes.position)];
  if (attributes.normal) entries.push(attribute(1, attributes.normal));
  if (attributes.uv) entries.push(attribute(2, attributes.uv));
  return entries;
}

function attribute(shaderLocation: number, source: { readonly offset: number; readonly format: GPUVertexFormat }): GPUVertexAttribute {
  return { shaderLocation, offset: source.offset, format: source.format };
}
