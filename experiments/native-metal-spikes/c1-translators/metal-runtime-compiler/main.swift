import Darwin
import Foundation
import Metal

struct CompileResult: Codable {
  let ok: Bool
  let device: String?
  let languageVersion: String
  let functionNames: [String]
  let errorDescription: String?
}

guard CommandLine.arguments.count == 2 else {
  FileHandle.standardError.write(Data("usage: metal-runtime-compiler <input.metal>\n".utf8))
  exit(2)
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]

guard let device = MTLCreateSystemDefaultDevice() else {
  let result = CompileResult(
    ok: false,
    device: nil,
    languageVersion: "2.4",
    functionNames: [],
    errorDescription: "MTLCreateSystemDefaultDevice returned nil"
  )
  print(String(data: try encoder.encode(result), encoding: .utf8)!)
  exit(1)
}

do {
  let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
  let options = MTLCompileOptions()
  options.languageVersion = .version2_4
  let library = try device.makeLibrary(source: source, options: options)
  let result = CompileResult(
    ok: true,
    device: device.name,
    languageVersion: "2.4",
    functionNames: library.functionNames.sorted(),
    errorDescription: nil
  )
  print(String(data: try encoder.encode(result), encoding: .utf8)!)
} catch {
  let result = CompileResult(
    ok: false,
    device: device.name,
    languageVersion: "2.4",
    functionNames: [],
    errorDescription: (error as NSError).localizedDescription
  )
  print(String(data: try encoder.encode(result), encoding: .utf8)!)
  exit(1)
}
