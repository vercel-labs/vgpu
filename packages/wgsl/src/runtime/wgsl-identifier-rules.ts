/** WGSL keywords, verbatim from the spec keyword summary (https://www.w3.org/TR/WGSL/#keyword-summary). */
export const WGSL_SPEC_KEYWORDS: ReadonlySet<string> = new Set([
  "alias", "break", "case", "const", "const_assert", "continue", "continuing", "default", "diagnostic", "discard",
  "else", "enable", "false", "fn", "for", "if", "let", "loop", "override", "requires", "return", "struct",
  "switch", "true", "var", "while",
] as const);

/** vgpu module syntax extensions accepted by this package before WGSL emission. */
export const VGPU_MODULE_KEYWORDS: ReadonlySet<string> = new Set(["import", "export", "from", "as"] as const);

export const WGSL_KEYWORDS: ReadonlySet<string> = new Set([...WGSL_SPEC_KEYWORDS, ...VGPU_MODULE_KEYWORDS]);

/** WGSL reserved words, verbatim from the spec (https://www.w3.org/TR/WGSL/#reserved-words). */
export const WGSL_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "NULL", "Self", "abstract", "active", "alignas", "alignof", "as", "asm", "asm_fragment", "async", "attribute",
  "auto", "await", "become", "cast", "catch", "class", "co_await", "co_return", "co_yield", "coherent",
  "column_major", "common", "compile", "compile_fragment", "concept", "const_cast", "consteval", "constexpr", "constinit",
  "crate", "debugger", "decltype", "delete", "demote", "demote_to_helper", "do", "dynamic_cast", "enum", "explicit",
  "export", "extends", "extern", "external", "fallthrough", "filter", "final", "finally", "friend", "from", "fxgroup",
  "get", "goto", "groupshared", "highp", "impl", "implements", "import", "inline", "instanceof", "interface", "layout",
  "lowp", "macro", "macro_rules", "match", "mediump", "meta", "mod", "module", "move", "mut", "mutable", "namespace",
  "new", "nil", "noexcept", "noinline", "nointerpolation", "non_coherent", "noncoherent", "noperspective", "null",
  "nullptr", "of", "operator", "package",
  "packoffset", "partition", "pass", "patch", "pixelfragment", "precise", "precision", "premerge", "priv", "protected",
  "pub", "public", "readonly", "ref", "regardless", "register", "reinterpret_cast", "require", "resource", "restrict",
  "self", "set", "shared", "sizeof", "smooth", "snorm", "static", "static_assert", "static_cast", "std", "subroutine",
  "super", "target", "template", "this", "thread_local", "throw", "trait", "try", "type", "typedef", "typeid", "typename",
  "typeof", "union", "unless", "unorm", "unsafe", "unsized", "use", "using", "varying", "virtual", "volatile", "wgsl",
  "where", "with", "writeonly", "yield",
] as const);

/** Reserved by earlier WGSL drafts and by shipping implementations; never safe to generate. */
export const WGSL_LEGACY_RESERVED_WORDS: ReadonlySet<string> = new Set(["binding_array"] as const);

export function isWgslDeclarationIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
    && name !== "_"
    && !name.startsWith("__")
    && !WGSL_KEYWORDS.has(name)
    && !WGSL_RESERVED_WORDS.has(name)
    && !WGSL_LEGACY_RESERVED_WORDS.has(name);
}
