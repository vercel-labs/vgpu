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
import type { SceneGeometry } from "./geometry.ts";
import { Geometry, type GeometryOptions } from "./geometry-descriptor.ts";

type PrimitiveFactory = (device: Device, geometry: SceneGeometry) => MeshPrimitive;

const primitiveFactories: { readonly [K in SceneGeometry["kind"]]: PrimitiveFactory } = {
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
export function createGeometry(device: Device, geometry: SceneGeometry): Geometry {
  const primitive = primitiveFor(device, geometry);
  return new Geometry(device, primitiveGeometryOptions(primitive));
}

function primitiveFor(device: Device, geometry: SceneGeometry): MeshPrimitive {
  return primitiveFactories[geometry.kind](device, geometry);
}

function primitiveGeometryOptions(primitive: MeshPrimitive): GeometryOptions {
  const attrs = primitive.attributes;
  const attributes: Record<string, GPUVertexFormat | { readonly format: GPUVertexFormat; readonly offset?: number; readonly location?: number }> = {
    position: { ...attrs.position, location: 0 },
  };
  if (attrs.normal) attributes.normal = { ...attrs.normal, location: 1 };
  if (attrs.uv) attributes.uv = { ...attrs.uv, location: 2 };
  return {
    buffers: [{
      buffer: primitive.gpu?.vertexBuffer ?? primitive.vertexBuffer.gpu,
      stride: attrs.stride,
      attributes,
    }],
    vertexCount: primitive.vertexCount,
    indexBuffer: primitive.gpu?.indexBuffer ?? primitive.indexBuffer?.gpu,
    indexFormat: primitive.indexFormat,
    indexCount: primitive.indexCount,
  };
}
