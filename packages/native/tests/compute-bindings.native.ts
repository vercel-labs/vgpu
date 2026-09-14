import { beforeAll, expect, test } from "vitest";
import { generateMetalPackage } from "../src/index.ts";
import { compileLibrary, runConsumer } from "./native-support.ts";
import {
  computeMSL,
  computePackageInput,
  computeSetup,
  sizeTableMSL,
  sizeTablePackageInput,
} from "./compute-bindings-fixture.ts";

let library: Uint8Array;
beforeAll(async () => {
  library = await compileLibrary(computeMSL);
});

test("generated compute bindings dispatch using explicit storage offsets and fixed workgroup dimensions", async () => {
  const output = await runConsumer(
    { AppShaders: generateMetalPackage(computePackageInput(library)) },
    `${computeSetup}
let values = device.makeBuffer(length: 8, options: .storageModeShared)!
values.contents().storeBytes(of: UInt32(101), as: UInt32.self)
values.contents().storeBytes(of: UInt32(202), toByteOffset: 4, as: UInt32.self)
let output = device.makeBuffer(length: 4, options: .storageModeShared)!
let bindings = Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 4, length: 4), output: ShaderBufferRange(buffer: output, offset: 0, length: 4))
try dispatch { encoder in try count.bind(bindings, to: encoder) }
precondition(output.contents().load(as: UInt32.self) == 202)
print("COMPUTE_RANGE_DISPATCHED")
`
  );
  expect(output).toBe("COMPUTE_RANGE_DISPATCHED");
});

test("preparation retains a typed validated snapshot and rejects invalid ranges without overflow", async () => {
  const output = await runConsumer(
    { AppShaders: generateMetalPackage(computePackageInput(library)) },
    `${computeSetup}
let values = device.makeBuffer(length: 32, options: .storageModeShared)!
let output = device.makeBuffer(length: 4, options: .storageModeShared)!
let outputRange = ShaderBufferRange(buffer: output, offset: 0, length: 4)
let prepared = try count.prepare(Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 4, length: 7), output: outputRange))
precondition(prepared.bindings.values.buffer === values && prepared.bindings.values.offset == 4 && prepared.bindings.values.length == 7)
precondition(prepared.internalData.isEmpty)
for (offset, length) in [(-1, 4), (0, -1), (33, 4), (32, 4), (Int.max, Int.max), (4, Int.max)] {
  do {
    _ = try count.prepare(Count.Bindings(values: ShaderBufferRange(buffer: values, offset: offset, length: length), output: outputRange))
    fatalError("invalid storage range accepted")
  } catch ShaderBindingError.invalidRange(let binding, let actualOffset, let actualLength, let bufferLength) {
    precondition(binding == "values" && actualOffset == offset && actualLength == length && bufferLength == 32)
  }
}
print("COMPUTE_SNAPSHOT_VALIDATED")
`
  );
  expect(output).toBe("COMPUTE_SNAPSHOT_VALIDATED");
});

test("an invalid later compute range leaves every earlier encoded storage binding unchanged", async () => {
  const output = await runConsumer(
    { AppShaders: generateMetalPackage(computePackageInput(library)) },
    `${computeSetup}
let values = device.makeBuffer(length: 8, options: .storageModeShared)!
values.contents().storeBytes(of: UInt32(101), as: UInt32.self)
values.contents().storeBytes(of: UInt32(202), toByteOffset: 4, as: UInt32.self)
let output = device.makeBuffer(length: 4, options: .storageModeShared)!
output.contents().storeBytes(of: UInt32(0), as: UInt32.self)
let original = Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 0, length: 4), output: ShaderBufferRange(buffer: output, offset: 0, length: 4))
let replacement = Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 4, length: 4), output: ShaderBufferRange(buffer: output, offset: 0, length: 0))
var rejected = false
try dispatch { encoder in
  try count.bind(original, to: encoder)
  do { try count.bind(replacement, to: encoder) }
  catch ShaderBindingError.insufficientRange(let binding, let required, let actual) {
    rejected = binding == "output" && required == 4 && actual == 0
  }
}
print("ATOMIC:\\(rejected):\\(output.contents().load(as: UInt32.self))")
`
  );
  expect(output).toBe("ATOMIC:true:101");
});

test("prepared internal bytes use UInt32-visible ranges and reject unrepresentable lengths before conversion", async () => {
  const output = await runConsumer(
    { AppShaders: generateMetalPackage(sizeTablePackageInput(library)) },
    `${computeSetup}
precondition(device.supportsFamily(.apple1))
let values = device.makeBuffer(length: 128, options: .storageModeShared)!
let output = device.makeBuffer(length: 8, options: .storageModeShared)!
let outputRange = ShaderBufferRange(buffer: output, offset: 0, length: 8)
for length in [28, 31, 52] {
  let prepared = try count.prepare(Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 4, length: length), output: outputRange))
  precondition(prepared.internalData.count == 1)
  let payload = prepared.internalData[0]
  precondition(payload.slot.stage == .compute && payload.slot.index == 30 && payload.offsetAlignment == 4)
  precondition(payload.bytes == [0, 0, 0, 0, UInt8(length), 0, 0, 0])
  precondition(prepared.bindings.values.length == length)
}
for length in [Int(UInt32.max) + 1, Int.max] {
  do {
    _ = try count.prepare(Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 0, length: length), output: outputRange))
    fatalError("unrepresentable size accepted")
  } catch ShaderBindingError.unrepresentableLength(let binding, let maximum, let actual) {
    precondition(binding == "values" && maximum == Int(UInt32.max) && actual == length)
  }
}
print("INTERNAL_BYTES_USE_VISIBLE_RANGES")
`
  );
  expect(output).toBe("INTERNAL_BYTES_USE_VISIBLE_RANGES");
});

test("prepared compute binding reuses owned size bytes while raw binding prepares each new range", async () => {
  const generated = generateMetalPackage(
    sizeTablePackageInput(await compileLibrary(sizeTableMSL))
  );
  const output = await runConsumer(
    { AppShaders: generated },
    `${computeSetup}
let values = device.makeBuffer(length: 56, options: .storageModeShared)!
let words: [UInt32] = [99, 1, 0, 101, 2, 0, 202, 3, 0, 303, 4, 0, 404]
for (index, word) in words.enumerated() { values.contents().storeBytes(of: word, toByteOffset: 4 + index * 4, as: UInt32.self) }
let output = device.makeBuffer(length: 8, options: .storageModeShared)!
let outputRange = ShaderBufferRange(buffer: output, offset: 0, length: 8)
let short = Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 4, length: 28), output: outputRange)
let long = Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 4, length: 52), output: outputRange)
let prepared = try count.prepare(short)
try dispatch { encoder in try count.bind(prepared, to: encoder) }
precondition(output.contents().load(as: UInt32.self) == 2 && output.contents().load(fromByteOffset: 4, as: UInt32.self) == 202)
try dispatch { encoder in try count.bind(long, to: encoder) }
precondition(output.contents().load(as: UInt32.self) == 4 && output.contents().load(fromByteOffset: 4, as: UInt32.self) == 404)
let partial = Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 4, length: 31), output: outputRange)
try dispatch { encoder in try count.bind(partial, to: encoder) }
precondition(output.contents().load(as: UInt32.self) == 2 && output.contents().load(fromByteOffset: 4, as: UInt32.self) == 202)
let reloaded = try Count.load(device: device)
try dispatch { encoder in try reloaded.bind(prepared, to: encoder) }
precondition(output.contents().load(as: UInt32.self) == 2 && output.contents().load(fromByteOffset: 4, as: UInt32.self) == 202)
print("PREPARED_AND_RAW_RANGES_DISPATCHED")
`
  );
  expect(output).toBe("PREPARED_AND_RAW_RANGES_DISPATCHED");
});

test("invalid replacements preserve both existing resource slots and their effective size payload", async () => {
  const generated = generateMetalPackage(
    sizeTablePackageInput(await compileLibrary(sizeTableMSL))
  );
  const output = await runConsumer(
    { AppShaders: generated },
    `${computeSetup}
let values = device.makeBuffer(length: 108, options: .storageModeShared)!
for (offset, scale) in [(4, UInt32(101)), (56, UInt32(1001))] {
  let words: [UInt32] = [99, 1, 0, scale, 2, 0, 2 * scale, 3, 0, 3 * scale, 4, 0, 4 * scale]
  for (index, word) in words.enumerated() { values.contents().storeBytes(of: word, toByteOffset: offset + index * 4, as: UInt32.self) }
}
let output = device.makeBuffer(length: 8, options: .storageModeShared)!
let original = Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 4, length: 28), output: ShaderBufferRange(buffer: output, offset: 0, length: 8))
let replacement = Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 56, length: 52), output: ShaderBufferRange(buffer: output, offset: 0, length: 0))
var rejected = false
try dispatch { encoder in
  try count.bind(original, to: encoder)
  do { try count.bind(replacement, to: encoder) }
  catch ShaderBindingError.insufficientRange(let binding, _, _) { rejected = binding == "output" }
}
precondition(rejected)
precondition(output.contents().load(as: UInt32.self) == 2 && output.contents().load(fromByteOffset: 4, as: UInt32.self) == 202)
print("RESOURCE_AND_SIZE_PAYLOAD_UNCHANGED")
`
  );
  expect(output).toBe("RESOURCE_AND_SIZE_PAYLOAD_UNCHANGED");
});

test("size snapshots preserve sparse physical indices, owned bytes, and empty effective payloads", async () => {
  const input = sizeTablePackageInput(library);
  const program = input.programs[0]!;
  const compute = program.compute!;
  const sparse = {
    ...compute,
    storage: [
      {
        ...compute.storage[0]!,
        slots: [{ stage: "compute" as const, index: 2 }],
      },
      {
        ...compute.storage[0]!,
        name: "prefixOnly",
        slots: [{ stage: "compute" as const, index: 5 }],
      },
      {
        ...compute.storage[1]!,
        slots: [{ stage: "compute" as const, index: 29 }],
      },
    ],
  };
  for (const effective of [true, false]) {
    const generated = generateMetalPackage({
      ...input,
      programs: [
        {
          ...program,
          compute: {
            ...sparse,
            internalData: effective ? sparse.internalData : [],
          },
        },
      ],
    });
    const output = await runConsumer(
      { AppShaders: generated },
      `${computeSetup}
let values = device.makeBuffer(length: 131072, options: .storageModeShared)!
let bindings = Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 4, length: 31), prefixOnly: ShaderBufferRange(buffer: values, offset: 0, length: 0x010203), output: ShaderBufferRange(buffer: values, offset: 0, length: 8))
let prepared = try count.prepare(bindings)
if ${effective} {
  var expected = [UInt8](repeating: 0, count: 28)
  expected[12] = 31
  expected[24] = 3
  expected[25] = 2
  expected[26] = 1
  precondition(prepared.internalData.count == 1 && prepared.internalData[0].bytes == expected)
  var detached = prepared.internalData[0].bytes
  detached[12] = 250
  precondition(prepared.internalData[0].bytes[12] == 31)
} else {
  precondition(prepared.internalData.isEmpty)
}
print("SPARSE_SNAPSHOT_VALIDATED")
`
    );
    expect(output).toBe("SPARSE_SNAPSHOT_VALIDATED");
  }
});

test("Swift consumers cannot forge prepared snapshots or mutate their ranges and internal bytes", async () => {
  const generated = generateMetalPackage(sizeTablePackageInput(library));
  const base = `${computeSetup}
let buffer = device.makeBuffer(length: 32, options: .storageModeShared)!
let bindings = Count.Bindings(values: ShaderBufferRange(buffer: buffer, offset: 0, length: 28), output: ShaderBufferRange(buffer: buffer, offset: 0, length: 8))
`;
  const mutation = runConsumer(
    { AppShaders: generated },
    `${base}
var prepared = try count.prepare(bindings)
var payload = prepared.internalData[0]
prepared.bindings = bindings
prepared.internalData = []
payload.bytes[0] = 255
payload.offsetAlignment = 1
`
  );
  await expect(mutation).rejects.toThrow(/'bindings' is a 'let' constant/);
  await expect(mutation).rejects.toThrow(/'internalData' is a 'let' constant/);
  await expect(mutation).rejects.toThrow(/'bytes' is a 'let' constant/);
  await expect(mutation).rejects.toThrow(
    /'offsetAlignment' is a 'let' constant/
  );
  await expect(
    runConsumer(
      { AppShaders: generated },
      `${base}
let forged = Count.PreparedBindings(bindings: bindings, internalData: [], _device: device)
`
    )
  ).rejects.toThrow(/inaccessible due to 'fileprivate' protection level/);
});

test("storage validation enforces physical size and layout alignment without requiring CPU-visible resources", async () => {
  const input = computePackageInput(library);
  const program = input.programs[0];
  const generated = generateMetalPackage({
    ...input,
    programs: [
      {
        ...program,
        compute: {
          ...program.compute,
          storage: [
            {
              ...program.compute.storage[0],
              minimumBindingSize: 16,
              alignment: 16,
            },
            program.compute.storage[1],
          ],
        },
      },
    ],
  });
  const output = await runConsumer(
    { AppShaders: generated },
    `${computeSetup}
let values = device.makeBuffer(length: 64, options: .storageModeShared)!
memset(values.contents(), 0xa5, 64)
let output = device.makeBuffer(length: 4, options: .storageModePrivate)!
let outputRange = ShaderBufferRange(buffer: output, offset: 0, length: 4)
for offset in [1, 4, 8, 12] {
  do {
    _ = try count.prepare(Count.Bindings(values: ShaderBufferRange(buffer: values, offset: offset, length: 16), output: outputRange))
    fatalError("misaligned storage accepted")
  } catch ShaderBindingError.misalignedOffset(let binding, let required, let actual) {
    precondition(binding == "values" && required == 16 && actual == offset)
  }
}
for length in [0, 15] {
  do {
    _ = try count.prepare(Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 16, length: length), output: outputRange))
    fatalError("short storage accepted")
  } catch ShaderBindingError.insufficientRange(let binding, let required, let actual) {
    precondition(binding == "values" && required == 16 && actual == length)
  }
}
_ = try count.prepare(Count.Bindings(values: ShaderBufferRange(buffer: values, offset: 16, length: 19), output: outputRange))
let bytes = UnsafeRawBufferPointer(start: values.contents(), count: 64)
precondition(bytes.allSatisfy { $0 == 0xa5 })
print("STORAGE_LAYOUT_VALIDATED_WITHOUT_MEMORY_WRITES")
`
  );
  expect(output).toBe("STORAGE_LAYOUT_VALIDATED_WITHOUT_MEMORY_WRITES");
});
