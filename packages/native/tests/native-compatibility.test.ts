import { expect, test } from "vitest";
import { generateMetalPackage } from "../src/index.ts";
import { metalGenerationProfile } from "../src/compatibility.ts";
import {
  compilerIdentity,
  semanticContract,
  translationContract,
} from "../src/compiler/protocol.ts";
import {
  createMetalOutputRecord,
  parseMetalOutputRecord,
} from "../src/tooling/output-record.ts";

test("shared compatibility settings preserve the existing package bytes, artifact format and protocol identity", () => {
  const generated = generateMetalPackage({
    moduleName: "AppShaders",
    library: new Uint8Array([1, 2, 3]),
    programs: [{ name: "Count", functions: { compute: "count_main" } }],
  });
  expect(Buffer.from(generated.files["Package.swift"]).toString("utf8")).toBe(`// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "AppShaders",
  platforms: [.macOS(.v14)],
  products: [.library(name: "AppShaders", targets: ["AppShaders"])],
  targets: [.target(name: "AppShaders", resources: [.copy("Resources/Shaders.metallib")])]
)
`);
  expect(metalGenerationProfile.compiler).toBe(compilerIdentity);
  expect(metalGenerationProfile.semanticContract).toBe(semanticContract);
  expect(metalGenerationProfile.translationContract).toBe(translationContract);
  expect(metalGenerationProfile.metal).toEqual({
    sdk: "macosx",
    languageStandard: "macos-metal2.4",
    target: "air64-apple-macos14.0",
  });
  const record = parseMetalOutputRecord(createMetalOutputRecord({
    moduleName: "AppShaders",
    ownerConfiguration: "../vgpu.native.json",
    inputFingerprint: "a".repeat(64),
    files: generated.files,
  }));
  expect(record.format).toBe("vgpu-metal-package/v1");
});
