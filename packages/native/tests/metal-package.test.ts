import { expect, test } from "vitest";
import { generateMetalPackage, type MetalPackageInput } from "../src/index.ts";

function input(): MetalPackageInput {
  return {
    moduleName: "AppShaders",
    library: new Uint8Array([1, 2, 3]),
    programs: [{ name: "Triangle", functions: { vertex: "selected_vertex" } }],
  };
}

test("invalid module identities fail rather than becoming Swift declarations or paths", () => {
  for (const moduleName of [
    "",
    "1Shaders",
    "App-Shaders",
    "../Shaders",
    "café",
    "_",
  ]) {
    expect(() => generateMetalPackage({ ...input(), moduleName })).toThrow(
      /moduleName/
    );
  }
});

test("invalid program identities fail rather than being silently renamed", () => {
  for (const name of [
    "",
    "2Triangle",
    "two words",
    "Program/Name",
    "café",
    "_",
    "__Internal",
  ]) {
    expect(() =>
      generateMetalPackage({
        ...input(),
        programs: [{ name, functions: { vertex: "selected_vertex" } }],
      })
    ).toThrow(/programs\[0\]\.name/);
  }
});

test("Swift reserved words cannot become unescaped module or program declarations", () => {
  const keywords = [
    "associatedtype",
    "borrowing",
    "class",
    "consuming",
    "deinit",
    "enum",
    "extension",
    "fileprivate",
    "func",
    "import",
    "init",
    "inout",
    "internal",
    "let",
    "nonisolated",
    "open",
    "operator",
    "precedencegroup",
    "private",
    "protocol",
    "public",
    "rethrows",
    "static",
    "struct",
    "subscript",
    "typealias",
    "var",
    "break",
    "case",
    "catch",
    "continue",
    "default",
    "defer",
    "do",
    "else",
    "fallthrough",
    "for",
    "guard",
    "if",
    "in",
    "repeat",
    "return",
    "switch",
    "throw",
    "where",
    "while",
    "Any",
    "as",
    "await",
    "false",
    "is",
    "nil",
    "self",
    "Self",
    "super",
    "throws",
    "true",
    "try",
    "associativity",
    "async",
    "convenience",
    "didSet",
    "dynamic",
    "final",
    "get",
    "indirect",
    "infix",
    "lazy",
    "left",
    "mutating",
    "none",
    "nonmutating",
    "optional",
    "override",
    "package",
    "postfix",
    "precedence",
    "prefix",
    "Protocol",
    "required",
    "right",
    "set",
    "some",
    "Type",
    "unowned",
    "weak",
    "willSet",
    "actor",
    "any",
    "isolated",
    "macro",
    "sending",
  ];
  for (const name of keywords) {
    expect(() =>
      generateMetalPackage({ ...input(), moduleName: name })
    ).toThrow(/moduleName/);
    expect(() =>
      generateMetalPackage({
        ...input(),
        programs: [{ name, functions: { vertex: "selected_vertex" } }],
      })
    ).toThrow(/programs\[0\]\.name/);
  }
});

test("generated and imported names cannot be shadowed by module or program identities", () => {
  const reserved = [
    "ShaderLoadError",
    "ShaderStage",
    "_ShaderLibrary",
    "Functions",
    "Metal",
    "Foundation",
    "Dispatch",
    "CryptoKit",
    "Swift",
    "PackageDescription",
    "Error",
    "String",
    "Data",
    "Bundle",
    "MTLFunction",
    "MTLLibrary",
    "MTLDevice",
    "MTLFunctionType",
    "DispatchData",
    "SHA256",
    "Sendable",
  ];
  for (const name of reserved.flatMap((name) => [
    name,
    name.toLowerCase(),
    name.toUpperCase(),
  ])) {
    expect(() =>
      generateMetalPackage({ ...input(), moduleName: name })
    ).toThrow(/moduleName/);
    expect(() =>
      generateMetalPackage({
        ...input(),
        programs: [{ name, functions: { vertex: "selected_vertex" } }],
      })
    ).toThrow(/programs\[0\]\.name/);
  }
});

test("program identities remain distinct from each other and the module on case-insensitive filesystems", () => {
  for (const names of [
    ["Triangle", "Triangle"],
    ["Triangle", "triangle"],
    ["AppShaders"],
    ["appshaders"],
  ]) {
    expect(() =>
      generateMetalPackage({
        ...input(),
        programs: names.map((name) => ({
          name,
          functions: { vertex: "selected_vertex" },
        })),
      })
    ).toThrow(/collid|duplicate/);
  }
});

test("generation requires nonempty compiled library bytes rather than coercing another value", () => {
  for (const library of [
    new Uint8Array(),
    [],
    [1, 2],
    "library",
    null,
    undefined,
    new ArrayBuffer(3),
    new Uint16Array([1]),
  ]) {
    expect(() =>
      generateMetalPackage({ ...input(), library } as MetalPackageInput)
    ).toThrow(/library/);
  }
});

test("generation requires a nonempty list of named program records", () => {
  for (const programs of [
    [],
    null,
    undefined,
    {},
    "Triangle",
    [null],
    [false],
    ["Triangle"],
    [{}],
    [undefined],
    new Array(1),
  ]) {
    expect(() =>
      generateMetalPackage({ ...input(), programs } as MetalPackageInput)
    ).toThrow(/programs/);
  }
});

test("a malformed top-level input fails with an input diagnostic", () => {
  for (const value of [null, undefined, [], "AppShaders", 3, false]) {
    expect(() =>
      generateMetalPackage(value as unknown as MetalPackageInput)
    ).toThrow(/input/);
  }
});

test("a program selects render stages or compute, never an empty or mixed stage map", () => {
  for (const functions of [
    {},
    null,
    undefined,
    [],
    "selected_vertex",
    1,
    new Map(),
    new Date(),
    { geometry: "entry" },
    { vertex: "entry", typo: "entry" },
    { vertex: "entry", compute: "entry" },
    { fragment: "entry", compute: "entry" },
    { vertex: "entry", [Symbol("unknown")]: "entry" },
  ]) {
    expect(() =>
      generateMetalPackage({
        ...input(),
        programs: [{ name: "Triangle", functions }],
      } as MetalPackageInput)
    ).toThrow(/programs\[0\]\.functions/);
  }
});

test("every selected stage names one nonempty emitted Metal identifier", () => {
  for (const emittedName of [
    "",
    " ",
    "2entry",
    "entry-name",
    "entry/name",
    "entry\nname",
    '"entry"',
    "café",
    null,
    undefined,
    1,
    false,
    {},
    [],
  ]) {
    for (const stage of ["vertex", "fragment", "compute"]) {
      expect(() =>
        generateMetalPackage({
          ...input(),
          programs: [{ name: "Triangle", functions: { [stage]: emittedName } }],
        } as MetalPackageInput)
      ).toThrow(new RegExp(`programs\\[0\\]\\.functions\\.${stage}`));
    }
  }
});

test("equivalent inputs produce identical package bytes regardless of field, stage, or program order", () => {
  const first = generateMetalPackage({
    moduleName: "AppShaders",
    library: new Uint8Array([1, 2, 3]),
    programs: [
      {
        name: "Triangle",
        functions: { vertex: "selected_vertex", fragment: "selected_fragment" },
      },
      { name: "Step", functions: { compute: "selected_compute" } },
    ],
  });
  const reordered = generateMetalPackage({
    programs: [
      { functions: { compute: "selected_compute" }, name: "Step" },
      {
        functions: { fragment: "selected_fragment", vertex: "selected_vertex" },
        name: "Triangle",
      },
    ],
    library: new Uint8Array([1, 2, 3]),
    moduleName: "AppShaders",
  });
  expect(reordered).toEqual(first);
});

test("the generated package snapshots only the supplied library view before caller mutation", () => {
  const backing = new Uint8Array([90, 1, 2, 3, 91]);
  const generated = generateMetalPackage({
    ...input(),
    library: backing.subarray(1, 4),
  });
  const expected = generateMetalPackage(input());
  backing.fill(255);
  expect(generated).toEqual(expected);
});

test("canonical generation accepts readonly input without mutating the caller's configuration", () => {
  const configuration = Object.freeze({
    ...input(),
    programs: Object.freeze([
      Object.freeze({
        name: "Triangle",
        functions: Object.freeze({
          fragment: "selected_fragment",
          vertex: "selected_vertex",
        }),
      }),
      Object.freeze({
        name: "Step",
        functions: Object.freeze({ compute: "selected_compute" }),
      }),
    ]),
  });
  const before = structuredClone(configuration);
  generateMetalPackage(configuration);
  expect(configuration).toEqual(before);
});
