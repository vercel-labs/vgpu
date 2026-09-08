import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { generateMetalPackage } from "../src/index.ts";
import {
  createMetalOutputRecord,
  parseMetalOutputRecord,
} from "../src/tooling/output-record.ts";

const generated = generateMetalPackage({
  moduleName: "AppShaders",
  programs: [{ name: "Triangle", functions: { vertex: "vertex_main" } }],
  library: new Uint8Array([1, 2, 3]),
});

test("parsed integrity metadata retains an immutable validated file and owner snapshot", () => {
  const record = parseMetalOutputRecord(createMetalOutputRecord(input));
  expect(Reflect.set(record, "ownerConfiguration", "../another.json")).toBe(
    false
  );
  expect(Reflect.set(record.files[0], "sha256", "b".repeat(64))).toBe(false);
  expect(Reflect.set(record.files, "length", 0)).toBe(false);
  expect(record.ownerConfiguration).toBe(input.ownerConfiguration);
  expect(record.files).toHaveLength(3);
});

test("record creation cannot emit metadata that exceeds the reader's format limit", () => {
  expect(() =>
    createMetalOutputRecord({
      ...input,
      ownerConfiguration: `../${"x".repeat(64 * 1024)}.json`,
    })
  ).toThrow();
});

test("malformed, invalid-UTF8, and oversized records fail with a typed record diagnostic", () => {
  const valid = Buffer.from(createMetalOutputRecord(input)).toString("utf8");
  const badUtf8 = Buffer.from(
    valid.replace("vgpu.native.json", "INVALID_BYTE")
  );
  badUtf8[badUtf8.indexOf("INVALID_BYTE")] = 0xff;
  for (const bytes of [
    Buffer.from("{broken"),
    badUtf8,
    Buffer.from(valid.padEnd(64 * 1024 + 1, " ")),
  ]) {
    try {
      parseMetalOutputRecord(bytes);
      throw new Error("Unexpected accepted record");
    } catch (error) {
      expect(error).toMatchObject({
        name: "MetalOutputRecordError",
        code: "invalid-output-record",
      });
    }
  }
  expect(
    parseMetalOutputRecord(Buffer.from(valid.padEnd(64 * 1024, " "))).moduleName
  ).toBe("AppShaders");
});

test("unsupported or altered record schemas cannot become verified metadata", () => {
  const valid = JSON.parse(
    Buffer.from(createMetalOutputRecord(input)).toString("utf8")
  );
  for (const value of [
    null,
    [],
    { ...valid, schemaVersion: 2 },
    { ...valid, format: "unknown/v1" },
    { ...valid, extra: true },
    { ...valid, moduleName: "Metal" },
    { ...valid, ownerConfiguration: "/absolute/config.json" },
    { ...valid, inputFingerprint: "not a hash" },
    { ...valid, files: [] },
    { ...valid, files: [valid.files[0], valid.files[0], valid.files[2]] },
    {
      ...valid,
      files: valid.files.map((file: object) => ({ ...file, extra: true })),
    },
    {
      ...valid,
      files: valid.files.map((file: object) => ({
        ...file,
        path: "../outside",
      })),
    },
    {
      ...valid,
      files: valid.files.map((file: object) => ({ ...file, sha256: "bad" })),
    },
  ]) {
    expect(() =>
      parseMetalOutputRecord(Buffer.from(JSON.stringify(value)))
    ).toThrow();
  }
});

test("versioned output records round trip independently of generated file enumeration order", () => {
  const bytes = createMetalOutputRecord(input);
  expect(
    createMetalOutputRecord({
      ...input,
      files: Object.fromEntries(Object.entries(input.files).reverse()),
    })
  ).toEqual(bytes);
  const parsed = parseMetalOutputRecord(bytes);
  expect(parsed.moduleName).toBe("AppShaders");
  expect(parsed.files.map((file) => file.path)).toEqual(
    Object.keys(input.files).sort()
  );
  expect(
    parsed.files.some((file) => file.path === ".vgpu-native-output.json")
  ).toBe(false);
});

test("record identities use a canonical outside configuration path and a SHA-256 input fingerprint", () => {
  for (const ownerConfiguration of [
    "/absolute/config.json",
    "config.json",
    "../",
    "../../config/../vgpu.native.json",
    "..\\config.json",
    "../bad\u0000.json",
    "../\ud800.json",
  ]) {
    expect(() =>
      createMetalOutputRecord({ ...input, ownerConfiguration })
    ).toThrow(/configuration/i);
  }
  for (const inputFingerprint of [
    "",
    "x".repeat(64),
    "A".repeat(64),
    "a".repeat(63),
  ]) {
    expect(() =>
      createMetalOutputRecord({ ...input, inputFingerprint })
    ).toThrow(/fingerprint/i);
  }
});

test("records only describe the exact generated package payload, never missing or additional files", () => {
  const missing = { ...input.files };
  delete missing["Package.swift"];
  for (const files of [
    missing,
    { ...input.files, "handwritten.swift": new Uint8Array([1]) },
    { ...input.files, "../outside": new Uint8Array([1]) },
    { ...input.files, ".vgpu-native-output.json": new Uint8Array([1]) },
    { ...input.files, "Package.swift": new Uint8Array() },
    { ...input.files, "Package.swift": "not byte data" },
  ]) {
    expect(() =>
      createMetalOutputRecord({ ...input, files } as typeof input)
    ).toThrow();
  }
});
const input = {
  moduleName: "AppShaders",
  ownerConfiguration: "../../vgpu.native.json",
  inputFingerprint: "a".repeat(64),
  files: generated.files,
};

test("an output record identifies its owner separately from input freshness and hashes every generated file", () => {
  const bytes = createMetalOutputRecord(input);
  const record = JSON.parse(Buffer.from(bytes).toString("utf8"));
  expect(record).toEqual({
    schemaVersion: 1,
    format: "vgpu-metal-package/v1",
    moduleName: "AppShaders",
    ownerConfiguration: "../../vgpu.native.json",
    inputFingerprint: "a".repeat(64),
    files: Object.keys(generated.files)
      .sort()
      .map((path) => ({
        path,
        sha256: createHash("sha256")
          .update(generated.files[path])
          .digest("hex"),
      })),
  });
  const changedInputs = JSON.parse(
    Buffer.from(
      createMetalOutputRecord({ ...input, inputFingerprint: "b".repeat(64) })
    ).toString("utf8")
  );
  expect(changedInputs.ownerConfiguration).toBe(record.ownerConfiguration);
  expect(changedInputs.inputFingerprint).not.toBe(record.inputFingerprint);
  expect(Object.keys(generated.files)).not.toContain(
    ".vgpu-native-output.json"
  );
});
