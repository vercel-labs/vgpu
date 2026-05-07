import type { VertexLayoutKind } from "./material-factory.ts";

const position = Object.freeze({ shaderLocation: 0, offset: 0, format: "float32x3" as const });
const normal = Object.freeze({ shaderLocation: 1, offset: 12, format: "float32x3" as const });
const uvAt12 = Object.freeze({ shaderLocation: 1, offset: 12, format: "float32x2" as const });
const uvAt24 = Object.freeze({ shaderLocation: 2, offset: 24, format: "float32x2" as const });

export function vertexBufferLayout(kind: VertexLayoutKind): GPUVertexBufferLayout {
  if (kind === "position-only") return { arrayStride: 12, attributes: [position] };
  if (kind === "position-normal") return { arrayStride: 24, attributes: [position, normal] };
  if (kind === "position-uv") return { arrayStride: 20, attributes: [position, uvAt12] };
  return { arrayStride: 32, attributes: [position, normal, uvAt24] };
}
