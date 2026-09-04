const swiftIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const generatedProgramMemberNames = new Set(["bindings", "artifact"]);
const generatedModuleNamespaces = new Set(["swift", "foundation", "vgpuabi"]);

// generatedSwift ABI 1 uses one conservative Swift 6 set: the union of names
// that fail in any public nominal/type-reference or property/initializer/access
// position emitted by the proposed generator. Contextual keywords that compile
// in every one of those positions remain valid authored spellings.
const swift6ForbiddenIdentifiers = new Set([
  "Any",
  "Protocol",
  "Self",
  "Type",
  "any",
  "as",
  "associatedtype",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "continue",
  "default",
  "defer",
  "deinit",
  "do",
  "each",
  "else",
  "enum",
  "extension",
  "fallthrough",
  "false",
  "fileprivate",
  "for",
  "func",
  "guard",
  "if",
  "import",
  "in",
  "init",
  "inout",
  "internal",
  "is",
  "let",
  "nil",
  "operator",
  "precedencegroup",
  "private",
  "protocol",
  "public",
  "repeat",
  "rethrows",
  "return",
  "self",
  "some",
  "static",
  "struct",
  "subscript",
  "super",
  "switch",
  "throw",
  "throws",
  "true",
  "try",
  "typealias",
  "var",
  "where",
  "while",
]);

/**
 * Validates the exact public spellings selected for generated Swift. The
 * generator does not escape, recase, or suffix authored shader identifiers.
 */
export function assertSwiftPresentation(
  { module, program, bindings, types },
  { failWith }
) {
  const fail = (message) => failWith("VGPU-C1-ASSEMBLY-PRESENTATION", message);
  const moduleScope = [
    ["module", module.swiftName],
    ["program", program.swiftName],
    ...Object.entries(types)
      .filter(([, type]) => type.kind === "struct")
      .map(([id, type]) => [`struct ${id}`, type.swiftName]),
  ];
  assertScope(moduleScope, "generated module", fail);
  assertGeneratedModuleNamespaces(moduleScope, fail);
  assertGeneratedProgramMemberNames(types, program, fail);

  assertScope(
    bindings.map((binding) => [`binding ${binding.id}`, binding.swiftName]),
    `program ${JSON.stringify(program.name)} bindings`,
    fail
  );

  for (const [id, type] of Object.entries(types)) {
    if (type.kind !== "struct") continue;
    assertScope(
      type.members.map((member, index) => [
        `member ${index} of ${id}`,
        member.swiftName,
      ]),
      `struct ${JSON.stringify(type.swiftName)} members`,
      fail
    );
  }
}

function assertGeneratedModuleNamespaces(entries, fail) {
  for (const [label, name] of entries) {
    if (
      typeof name === "string" &&
      generatedModuleNamespaces.has(name.toLowerCase())
    ) {
      fail(
        `${label} shadows generated module namespace ${JSON.stringify(name)}`
      );
    }
  }
}

function assertGeneratedProgramMemberNames(types, program, fail) {
  const reserved = new Set(generatedProgramMemberNames);
  if (
    program.kind === "draw" &&
    program.entryPoints?.vertex?.inputs?.some((value) =>
      Object.hasOwn(value, "location")
    )
  ) {
    reserved.add("vertex");
  }
  for (const [id, type] of Object.entries(types)) {
    if (
      type.kind === "struct" &&
      typeof type.swiftName === "string" &&
      reserved.has(type.swiftName.toLowerCase())
    ) {
      fail(
        `struct ${id} uses generated program API name ${JSON.stringify(
          type.swiftName
        )}`
      );
    }
  }
}

function assertScope(entries, scope, fail) {
  const folded = new Map();
  for (const [label, name] of entries) {
    assertPublicName(name, label, fail);
    const key = name.toLowerCase();
    const previous = folded.get(key);
    if (previous) {
      fail(
        `${scope} contains case-insensitive name collision between ${JSON.stringify(
          previous
        )} and ${JSON.stringify(name)}`
      );
    }
    folded.set(key, name);
  }
}

function assertPublicName(name, label, fail) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > 256 ||
    !name.isWellFormed() ||
    name.normalize("NFC") !== name ||
    !swiftIdentifier.test(name)
  ) {
    fail(`${label} is not a canonical Swift identifier`);
  }
  if (name === "_" || swift6ForbiddenIdentifiers.has(name)) {
    fail(`${label} uses reserved Swift name ${JSON.stringify(name)}`);
  }
  if (name.toLowerCase().startsWith("_vgpu")) {
    fail(
      `${label} uses the generated helper namespace ${JSON.stringify(name)}`
    );
  }
}
