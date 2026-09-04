import { inflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { GET } from "./route";

function readEntries(archive: Uint8Array): Map<string, string> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const entries = new Map<string, string>();
  let offset = 0;

  while (view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const contentStart = nameStart + nameLength + extraLength;
    const name = new TextDecoder().decode(archive.slice(nameStart, nameStart + nameLength));
    const content = inflateRawSync(
      archive.slice(contentStart, contentStart + compressedSize),
    ).toString();
    entries.set(name, content);
    offset = contentStart + compressedSize;
  }

  return entries;
}

describe("example ZIP route", () => {
  it("downloads the source under an example directory", async () => {
    const response = await GET(new Request("https://vgpu.sh/examples/gradient/download"), {
      params: Promise.resolve({ lang: "en", slug: "gradient" }),
    });
    const archive = new Uint8Array(await response.arrayBuffer());
    const [[name, content]] = readEntries(archive);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="gradient.zip"',
    );
    expect(name).toBe("gradient/index.tsx");
    expect(content).toContain("export function Example()");
  });

  it("makes public asset URLs portable", async () => {
    const response = await GET(new Request("https://vgpu.sh/examples/three-tsl/download"), {
      params: Promise.resolve({ lang: "en", slug: "three-tsl" }),
    });
    const entries = readEntries(new Uint8Array(await response.arrayBuffer()));

    expect(entries.get("three-tsl/environment.ts")).toContain(
      'HDRI_URL = "https://vgpu.sh/examples/three-tsl/sunset.exr"',
    );
  });
});
