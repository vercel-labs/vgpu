const swiftIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
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
 * Program aggregation owns collisions involving local versus shared type
 * placement; this boundary validates only spelling and intrinsic member
 * scopes that are already known.
 */
export function assertSwiftPresentationForProgramAssembly(
  { module, program, bindings, overrides, types },
  { failWith }
) {
  const fail = (message) => failWith("VGPU-C1-ASSEMBLY-PRESENTATION", message);
  const nominalNames = [
    ["module", module.swiftName],
    ["program", program.swiftName],
    ...Object.entries(types)
      .filter(([, type]) => type.kind === "struct")
      .map(([id, type]) => [`struct ${id}`, type.swiftName]),
  ];
  for (const [label, name] of nominalNames) {
    assertPublicName(name, label, fail);
  }
  assertGeneratedModuleNamespaces(nominalNames, fail);

  assertScope(
    bindings.map((binding) => [`binding ${binding.id}`, binding.swiftName]),
    `program ${JSON.stringify(program.name)} bindings`,
    fail
  );
  if (!Array.isArray(overrides)) {
    fail(`program ${JSON.stringify(program.name)} overrides must be an array`);
  }
  assertScope(
    overrides.map((override) => [
      `override ${override.names.wgsl}`,
      override.swiftName,
    ]),
    `program ${JSON.stringify(program.name)} overrides`,
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
