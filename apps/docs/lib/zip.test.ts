import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createZip } from "./zip";

function readFirstEntry(archive: Uint8Array) {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  const compressedSize = view.getUint32(18, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const nameStart = 30;
  const contentStart = nameStart + nameLength + extraLength;

  return {
    name: new TextDecoder().decode(archive.slice(nameStart, contentStart)),
    content: inflateRawSync(archive.slice(contentStart, contentStart + compressedSize)).toString(),
  };
}

describe("createZip", () => {
  it("creates a deterministic ZIP with readable source files", () => {
    const files = [
      { name: "gradient/index.tsx", content: "export const Example = () => null;\n" },
      { name: "gradient/shader.wgsl", content: "@fragment fn main() {}\n" },
    ] as const;
    const first = createZip(files);
    const second = createZip(files);

    expect(first).toEqual(second);
    expect(readFirstEntry(first)).toEqual({
      name: "gradient/index.tsx",
      content: files[0].content,
    });
    expect(new DataView(first.buffer).getUint32(first.byteLength - 22, true)).toBe(0x06054b50);
  });

  it("rejects paths that could escape the archive root", () => {
    expect(() => createZip([{ name: "../secret", content: "nope" }])).toThrow(
      "Unsafe ZIP entry name",
    );
  });
});
