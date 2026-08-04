import { describe, expect, it } from 'vitest';
import { readBoundedLocalFile } from './safe-local-path';

describe('bounded local artifact reads', () => {
  it('detects growth after fstat without reading or allocating beyond the response cap', async () => {
    const source = new Uint8Array([1, 2]);
    const readLengths: number[] = [];
    const handle = {
      stat: async () => ({ size: 1, isFile: () => true }),
      read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        readLengths.push(length);
        const bytesRead = Math.min(length, source.byteLength - position);
        if (bytesRead > 0) buffer.set(source.subarray(position, position + bytesRead), offset);
        return { bytesRead };
      },
    };

    await expect(readBoundedLocalFile(handle, 1, 'growing.bin')).rejects.toThrow(
      'Stored artifact exceeds response limit: growing.bin',
    );
    expect(readLengths).toEqual([1, 1]);
  });
});
