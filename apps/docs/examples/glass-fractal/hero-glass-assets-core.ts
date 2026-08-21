import type { Geometry, GeometryBufferOptions, Gpu } from 'vgpu';
import { geometry } from 'vgpu';
import type { Texture } from 'vgpu/core';
import { cubeView } from 'vgpu/core';

const MESH_HEADER_SIZE = 40;
const CUBEMAP_COLUMNS = 3;
const CUBEMAP_ROWS = 2;

export interface HeroGlassAssets {
  readonly geometry: Geometry;
  readonly wireframeGeometry: Geometry;
  readonly meshMin: readonly [number, number, number];
  readonly meshMax: readonly [number, number, number];
  readonly fractalGeometry: Geometry;
  readonly fractalWireframeGeometry: Geometry;
  readonly fractalMeshMin: readonly [number, number, number];
  readonly fractalMeshMax: readonly [number, number, number];
  readonly environment: Texture;
  readonly environmentView: GPUTextureView;
  dispose(): void;
}

export interface RgbaAtlas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** Environment-neutral mesh decoding and cubemap upload used by browser and Node. */
export function createHeroGlassAssets(
  gpu: Gpu,
  glassMeshBuffer: ArrayBuffer,
  fractalMeshBuffer: ArrayBuffer,
  atlas: RgbaAtlas
): HeroGlassAssets {
  const glassMesh = decodeMesh(gpu, glassMeshBuffer, 'glass-pyramid');
  let fractalMesh: ReturnType<typeof decodeMesh> | undefined;
  let environment: Texture | undefined;
  try {
    fractalMesh = decodeMesh(gpu, fractalMeshBuffer, 'fractal-pyramid-face-l7');
    const faceSize = atlas.height / CUBEMAP_ROWS;
    const mipLevelCount = Math.floor(Math.log2(faceSize)) + 1;
    let expectedWidth = 0;
    for (let level = 0; level < mipLevelCount; level++)
      expectedWidth += CUBEMAP_COLUMNS * Math.max(1, faceSize >> level);
    if (
      !Number.isInteger(faceSize) ||
      2 ** (mipLevelCount - 1) !== faceSize ||
      atlas.width !== expectedWidth ||
      atlas.data.byteLength !== atlas.width * atlas.height * 4
    ) {
      throw new Error('Hero cubemap atlas must contain a packed spherical mip chain.');
    }
    environment = gpu.device.createTexture({
      size: [faceSize, faceSize, 6],
      format: 'rgba8unorm-srgb',
      usage: ['texture_binding', 'copy_dst'],
      mipLevelCount,
      label: 'homepage-light-glass-studio-cubemap',
    });
    uploadPackedCubemapMipAtlas(gpu, environment, atlas, faceSize, mipLevelCount);
    const loadedEnvironment = environment;
    const loadedFractal = fractalMesh;
    const environmentView = cubeView(loadedEnvironment, {
      compat: true,
      label: 'homepage-light-glass-studio-cubemap-array-view',
    });
    let disposed = false;
    return {
      ...glassMesh,
      fractalGeometry: loadedFractal.geometry,
      fractalWireframeGeometry: loadedFractal.wireframeGeometry,
      fractalMeshMin: loadedFractal.meshMin,
      fractalMeshMax: loadedFractal.meshMax,
      environment: loadedEnvironment,
      environmentView,
      dispose() {
        if (disposed) return;
        disposed = true;
        glassMesh.geometry.destroy();
        glassMesh.wireframeGeometry.destroy();
        loadedFractal.geometry.destroy();
        loadedFractal.wireframeGeometry.destroy();
        loadedEnvironment.destroy();
      },
    };
  } catch (error) {
    glassMesh.geometry.destroy();
    glassMesh.wireframeGeometry.destroy();
    fractalMesh?.geometry.destroy();
    fractalMesh?.wireframeGeometry.destroy();
    environment?.destroy();
    throw error;
  }
}

function uploadPackedCubemapMipAtlas(
  gpu: Gpu,
  environment: Texture,
  atlas: RgbaAtlas,
  faceSize: number,
  mipLevelCount: number
): void {
  let levelOffsetX = 0;
  for (let mipLevel = 0; mipLevel < mipLevelCount; mipLevel++) {
    const mipSize = Math.max(1, faceSize >> mipLevel);
    for (let face = 0; face < 6; face++) {
      const tileX = levelOffsetX + (face % CUBEMAP_COLUMNS) * mipSize;
      const tileY = Math.floor(face / CUBEMAP_COLUMNS) * mipSize;
      const pixels = new Uint8Array(mipSize * mipSize * 4);
      for (let row = 0; row < mipSize; row++) {
        const sourceStart = ((tileY + row) * atlas.width + tileX) * 4;
        pixels.set(atlas.data.subarray(sourceStart, sourceStart + mipSize * 4), row * mipSize * 4);
      }
      uploadCubemapMip(gpu, environment, pixels, face, mipLevel, mipSize);
    }
    levelOffsetX += CUBEMAP_COLUMNS * mipSize;
  }
}

function uploadCubemapMip(
  gpu: Gpu,
  environment: Texture,
  pixels: Uint8Array,
  face: number,
  mipLevel: number,
  size: number
): void {
  const sourceBytesPerRow = size * 4;
  const bytesPerRow = Math.ceil(sourceBytesPerRow / 256) * 256;
  const upload = new Uint8Array(bytesPerRow * size);
  for (let row = 0; row < size; row++)
    upload.set(
      pixels.subarray(row * sourceBytesPerRow, (row + 1) * sourceBytesPerRow),
      row * bytesPerRow
    );
  gpu.gpu.queue.writeTexture(
    { texture: environment.gpu, mipLevel, origin: [0, 0, face] },
    upload,
    { bytesPerRow, rowsPerImage: size },
    [size, size, 1]
  );
}

function decodeMesh(gpu: Gpu, buffer: ArrayBuffer, label: string) {
  if (buffer.byteLength < MESH_HEADER_SIZE) throw new Error('Hero glass mesh header is truncated.');
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  const hasSphereTarget = magic === 'HGP2';
  if (magic !== 'HGP1' && !hasSphereTarget) throw new Error('Unsupported hero glass mesh format.');
  const vertexCount = view.getUint32(4, true),
    indexCount = view.getUint32(8, true),
    vertexStride = view.getUint32(12, true),
    expectedStride = hasSphereTarget ? 24 : 16;
  if (vertexStride !== expectedStride || vertexCount <= 0 || indexCount <= 0)
    throw new Error('Hero glass mesh layout is invalid.');
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
  const vertexByteLength = vertexCount * vertexStride,
    indexOffset = MESH_HEADER_SIZE + vertexByteLength,
    expectedLength = indexOffset + indexCount * 2;
  if (expectedLength !== buffer.byteLength)
    throw new Error('Hero glass mesh payload length is invalid.');
  const vertexData = new Uint8Array(buffer.slice(MESH_HEADER_SIZE, indexOffset));
  const indices = new Uint16Array(buffer.slice(indexOffset));
  const wireframeIndices = triangleEdges(indices);
  const buffers: GeometryBufferOptions[] = [
    {
      data: vertexData,
      stride: vertexStride,
      attributes: hasSphereTarget
        ? { packed_position: 'unorm16x4', packed_normal: 'snorm16x4', packed_sphere: 'snorm16x4' }
        : { packed_position: 'unorm16x4', packed_normal: 'snorm16x4' },
    },
  ];
  return {
    geometry: geometry(gpu, { label: `homepage-light-${label}`, buffers, indices }),
    wireframeGeometry: geometry(gpu, {
      label: `homepage-light-${label}-wireframe`,
      topology: 'line-list',
      buffers,
      indices: wireframeIndices,
    }),
    meshMin,
    meshMax,
  };
}

function triangleEdges(indices: Uint16Array): Uint16Array {
  const edges = new Set<string>();
  const result: number[] = [];
  const append = (a: number, b: number) => {
    const start = Math.min(a, b),
      end = Math.max(a, b),
      key = `${start}:${end}`;
    if (edges.has(key)) return;
    edges.add(key);
    result.push(start, end);
  };
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    append(indices[triangle]!, indices[triangle + 1]!);
    append(indices[triangle + 1]!, indices[triangle + 2]!);
    append(indices[triangle + 2]!, indices[triangle]!);
  }
  return new Uint16Array(result);
}
