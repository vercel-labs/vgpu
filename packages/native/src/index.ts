import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { metalGenerationProfile } from "./compatibility.js";
import { validateMetalPackageInput } from "./validation.js";
import { generateUniformDeclarations, uniformPackingSupport, type MetalUniform } from "./uniforms.js";
import { bindingSupport, generateBindingMethods, generateBindingsDeclaration, hasUniformBindings } from "./bindings.js";
import { computeSupport, generateComputeDeclarations, generateComputeMethods, type MetalCompute } from "./compute.js";

export type { MetalUniform, UniformFieldType } from "./uniforms.js";
export type { MetalUniformSlot } from "./bindings.js";
export type { MetalCompute, MetalStorage, MetalStorageBufferSizes } from "./compute.js";

export type MetalStage = "vertex" | "fragment" | "compute";

export interface MetalProgram {
  readonly name: string;
  readonly functions: Partial<Record<MetalStage, string>>;
  readonly uniforms?: readonly MetalUniform[];
  readonly compute?: MetalCompute;
}

export interface MetalPackageInput {
  readonly moduleName: string;
  readonly library: Uint8Array;
  readonly programs: readonly MetalProgram[];
}

export interface GeneratedMetalPackage {
  readonly files: Readonly<Record<string, Uint8Array>>;
}

/** Generates source and resource files without writing to the filesystem. */
export function generateMetalPackage(
  input: MetalPackageInput
): GeneratedMetalPackage {
  validateMetalPackageInput(input);
  const { moduleName } = input;
  const librarySHA256 = createHash("sha256")
    .update(input.library)
    .digest("hex");
  const programs = [...input.programs].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  );
  const stages: readonly MetalStage[] = ["vertex", "fragment", "compute"];
  const programSource = programs
    .map((program) => {
      const functions = stages
        .filter((stage) => Object.hasOwn(program.functions, stage))
        .map((stage) => [stage, program.functions[stage]!] as const);
      return `public enum ${program.name} {
${generateUniformDeclarations(program.uniforms ?? [])}${generateBindingsDeclaration(program.uniforms ?? [])}${generateComputeDeclarations(program.compute)}  public struct Functions {
${hasUniformBindings(program.uniforms ?? []) || program.compute ? "    fileprivate let _device: any MTLDevice\n" : ""}\
${functions
  .map(([stage]) => `    public let ${stage}: any MTLFunction`)
  .join("\n")}${generateBindingMethods(program.uniforms ?? [])}${generateComputeMethods(program.compute)}
  }

  public static func load(device: any MTLDevice) throws -> Functions {
    let library = try _ShaderLibrary.load(device: device)
    return Functions(
${hasUniformBindings(program.uniforms ?? []) || program.compute ? "      _device: device,\n" : ""}\
${functions
  .map(
    ([stage, name]) =>
      `      ${stage}: try _ShaderLibrary.function(library, name: "${name}", program: "${program.name}", stage: .${stage})`
  )
  .join(",\n")}
    )
  }
}`;
    })
    .join("\n\n");

  return {
    files: {
      "Package.swift": Buffer.from(`// swift-tools-version: ${metalGenerationProfile.swift.toolsVersion}
import PackageDescription

let package = Package(
  name: "${moduleName}",
  platforms: [.macOS(.${metalGenerationProfile.swift.macOSPlatform})],
  products: [.library(name: "${moduleName}", targets: ["${moduleName}"])],
  targets: [.target(name: "${moduleName}", resources: [.copy("Resources/Shaders.metallib")])]
)
`),
      [`Sources/${moduleName}/Shaders.generated.swift`]:
        Buffer.from(`import CryptoKit
import Dispatch
import Foundation
import Metal

public enum ShaderStage: String, Sendable {
  case vertex, fragment, compute
}

public enum ShaderLoadError: Error {
  case resourceUnavailable
  case resourceUnreadable(underlying: any Error)
  case libraryIntegrityMismatch
  case libraryCreationFailed(underlying: any Error)
  case missingFunction(program: String, stage: ShaderStage)
  case unexpectedFunctionStage(program: String, stage: ShaderStage, actual: MTLFunctionType)
  case functionConstantsUnsupported(program: String, stage: ShaderStage)
}

${programSource}

${programs.some((program) => program.uniforms?.length) ? uniformPackingSupport : ""}
${programs.some((program) => hasUniformBindings(program.uniforms ?? []) || program.compute) ? bindingSupport : ""}
${programs.some((program) => program.compute) ? computeSupport : ""}
private enum _ShaderLibrary {
  static func load(device: any MTLDevice) throws -> any MTLLibrary {
    guard let url = Bundle.module.url(forResource: "Shaders", withExtension: "metallib") else {
      throw ShaderLoadError.resourceUnavailable
    }
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch {
      throw ShaderLoadError.resourceUnreadable(underlying: error)
    }
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard digest == "${librarySHA256}" else {
      throw ShaderLoadError.libraryIntegrityMismatch
    }
    do {
      return try data.withUnsafeBytes { bytes in
        try device.makeLibrary(data: DispatchData(bytes: bytes))
      }
    } catch {
      throw ShaderLoadError.libraryCreationFailed(underlying: error)
    }
  }

  static func function(_ library: any MTLLibrary, name: String, program: String, stage: ShaderStage) throws -> any MTLFunction {
    guard let function = library.makeFunction(name: name) else {
      throw ShaderLoadError.missingFunction(program: program, stage: stage)
    }
    let expected: MTLFunctionType
    switch stage {
    case .vertex: expected = .vertex
    case .fragment: expected = .fragment
    case .compute: expected = .kernel
    }
    guard function.functionType == expected else {
      throw ShaderLoadError.unexpectedFunctionStage(program: program, stage: stage, actual: function.functionType)
    }
    guard function.functionConstantsDictionary.isEmpty else {
      throw ShaderLoadError.functionConstantsUnsupported(program: program, stage: stage)
    }
    return function
  }
}
`),
      [`Sources/${moduleName}/Resources/Shaders.metallib`]: Uint8Array.from(
        input.library
      ),
    },
  };
}
