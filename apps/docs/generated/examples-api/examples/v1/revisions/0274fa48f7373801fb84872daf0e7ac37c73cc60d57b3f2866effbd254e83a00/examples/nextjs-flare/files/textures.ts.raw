import type { Gpu } from 'vgpu';
import { BLUE_NOISE_SIZE, blueNoiseBytes } from './blue-noise-128';

// WebGPU usage flags: COPY_DST | TEXTURE_BINDING | RENDER_ATTACHMENT.
const TEXTURE_UPLOAD_USAGE = 0x02 | 0x04 | 0x10;

export function createBlueNoiseTexture(gpu: Gpu): GPUTexture {
  const texture = gpu.gpu.createTexture({
    label: 'nextjs-flare-blue-noise-128',
    size: [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE],
    format: 'r8unorm',
    usage: 0x02 | 0x04,
  });
  const bytesPerRow = 256;
  gpu.gpu.queue.writeTexture(
    { texture },
    padTextureRows(blueNoiseBytes(), BLUE_NOISE_SIZE, bytesPerRow, BLUE_NOISE_SIZE),
    { bytesPerRow, rowsPerImage: BLUE_NOISE_SIZE },
    [BLUE_NOISE_SIZE, BLUE_NOISE_SIZE],
  );
  return texture;
}

export function createLogoTexture(gpu: Gpu, width: number, height: number): GPUTexture {
  return gpu.gpu.createTexture({
    label: 'nextjs-flare-logo-raster',
    size: [width, height],
    format: 'rgba8unorm',
    usage: TEXTURE_UPLOAD_USAGE,
  });
}

export function uploadLogoTexture(
  gpu: Gpu,
  texture: GPUTexture,
  source: HTMLCanvasElement,
  width: number,
  height: number,
): void {
  gpu.gpu.queue.copyExternalImageToTexture({ source }, { texture }, [width, height]);
}

export function uploadLogoTextureRgba(
  gpu: Gpu,
  texture: GPUTexture,
  data: Uint8Array<ArrayBuffer>,
  width: number,
  height: number,
): void {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const upload =
    bytesPerRow === width * 4 ? data : padTextureRows(data, width * 4, bytesPerRow, height);
  gpu.gpu.queue.writeTexture(
    { texture },
    upload,
    { bytesPerRow, rowsPerImage: height },
    [width, height],
  );
}

function padTextureRows(
  data: Uint8Array<ArrayBuffer>,
  sourceBytesPerRow: number,
  destinationBytesPerRow: number,
  height: number,
): Uint8Array<ArrayBuffer> {
  const padded = new Uint8Array(destinationBytesPerRow * height);
  for (let row = 0; row < height; row += 1) {
    const sourceOffset = row * sourceBytesPerRow;
    padded.set(
      data.subarray(sourceOffset, sourceOffset + sourceBytesPerRow),
      row * destinationBytesPerRow,
    );
  }
  return padded;
}
