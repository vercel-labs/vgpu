export const WGSL_KEYWORDS: ReadonlySet<string> = new Set([
  "alias", "break", "case", "const", "const_assert", "continue", "continuing", "default", "diagnostic", "discard",
  "else", "enable", "false", "fn", "for", "if", "let", "loop", "override", "requires", "return", "struct",
  "switch", "true", "var", "while",
  // vgpu module syntax extensions accepted by this package before WGSL emission.
  "import", "export", "from", "as",
] as const);

export const WGSL_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "NULL", "Self", "abstract", "active", "alignas", "alignof", "as", "asm", "asm_fragment", "async", "attribute",
  "auto", "await", "become", "binding_array", "cast", "catch", "class", "co_await", "co_return", "co_yield", "coherent",
  "column_major", "common", "compile", "compile_fragment", "concept", "const_cast", "consteval", "constexpr", "constinit",
  "crate", "debugger", "decltype", "delete", "demote", "demote_to_helper", "do", "dynamic_cast", "enum", "explicit",
  "export", "extends", "extern", "external", "fallthrough", "filter", "final", "finally", "friend", "from", "fxgroup",
  "get", "goto", "groupshared", "highp", "impl", "implements", "import", "inline", "instanceof", "interface", "layout",
  "lowp", "macro", "macro_rules", "match", "mediump", "meta", "mod", "module", "move", "mut", "mutable", "namespace",
  "new", "nil", "noexcept", "noinline", "nointerpolation", "noperspective", "null", "nullptr", "of", "operator", "package",
  "packoffset", "partition", "pass", "patch", "pixelfragment", "precise", "precision", "premerge", "priv", "protected",
  "pub", "public", "readonly", "ref", "regardless", "register", "reinterpret_cast", "require", "resource", "restrict",
  "self", "set", "shared", "sizeof", "smooth", "snorm", "static", "static_assert", "static_cast", "std", "subroutine",
  "super", "target", "template", "this", "thread_local", "throw", "trait", "try", "typedef", "typeid", "typename",
  "typeof", "union", "unless", "unorm", "unsafe", "unsized", "use", "using", "varying", "virtual", "volatile", "wgsl",
  "where", "with", "writeonly", "yield",
] as const);

export const WGSL_PREDECLARED_TYPES: ReadonlySet<string> = new Set([
  "array", "atomic", "bool", "f16", "f32", "i32", "mat2x2", "mat2x3", "mat2x4", "mat3x2", "mat3x3", "mat3x4",
  "mat4x2", "mat4x3", "mat4x4", "ptr", "sampler", "sampler_comparison", "texture_1d", "texture_2d", "texture_2d_array",
  "texture_3d", "texture_cube", "texture_cube_array", "texture_depth_2d", "texture_depth_2d_array", "texture_depth_cube",
  "texture_depth_cube_array", "texture_depth_multisampled_2d", "texture_external", "texture_multisampled_2d", "texture_storage_1d",
  "texture_storage_2d", "texture_storage_2d_array", "texture_storage_3d", "u32", "vec2", "vec2f", "vec2h", "vec2i", "vec2u",
  "vec3", "vec3f", "vec3h", "vec3i", "vec3u", "vec4", "vec4f", "vec4h", "vec4i", "vec4u",
] as const);

export const WGSL_PREDECLARED_VALUES: ReadonlySet<string> = new Set([
  "abs", "acos", "acosh", "all", "any", "arrayLength", "asin", "asinh", "atan", "atan2", "atanh", "ceil", "clamp", "cos",
  "cosh", "countLeadingZeros", "countOneBits", "countTrailingZeros", "cross", "degrees", "determinant", "distance", "dot", "dot4I8Packed",
  "dot4U8Packed", "dpdx", "dpdxCoarse", "dpdxFine", "dpdy", "dpdyCoarse", "dpdyFine", "exp", "exp2", "extractBits", "faceForward",
  "firstLeadingBit", "firstTrailingBit", "floor", "fma", "fract", "frexp", "fwidth", "fwidthCoarse", "fwidthFine", "insertBits",
  "inverseSqrt", "ldexp", "length", "log", "log2", "max", "min", "mix", "modf", "normalize", "pack2x16float", "pack2x16snorm",
  "pack2x16unorm", "pack4x8snorm", "pack4x8unorm", "pack4xI8", "pack4xU8", "pack4xI8Clamp", "pack4xU8Clamp", "pow",
  "quantizeToF16", "radians", "reflect", "refract", "reverseBits", "round", "saturate", "select", "sign", "sin", "sinh", "smoothstep",
  "sqrt", "step", "storageBarrier", "tan", "tanh", "textureBarrier", "textureDimensions", "textureGather", "textureGatherCompare",
  "textureLoad", "textureNumLayers", "textureNumLevels", "textureNumSamples", "textureSample", "textureSampleBaseClampToEdge",
  "textureSampleBias", "textureSampleCompare", "textureSampleCompareLevel", "textureSampleGrad", "textureSampleLevel", "textureStore",
  "transpose", "trunc", "unpack2x16float", "unpack2x16snorm", "unpack2x16unorm", "unpack4x8snorm", "unpack4x8unorm",
  "unpack4xI8", "unpack4xU8", "workgroupBarrier",
] as const);

export const WGSL_BUILTIN_VALUES: ReadonlySet<string> = new Set([
  "frag_depth", "front_facing", "global_invocation_id", "instance_index", "local_invocation_id", "local_invocation_index",
  "num_workgroups", "position", "sample_index", "sample_mask", "subgroup_invocation_id", "subgroup_size", "vertex_index", "workgroup_id",
] as const);

export const WGSL_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  "align", "binding", "blend_src", "builtin", "compute", "diagnostic", "fragment", "group", "id", "interpolate", "invariant",
  "location", "must_use", "size", "vertex", "workgroup_size",
] as const);

export const WGSL_ADDRESS_SPACE_NAMES: ReadonlySet<string> = new Set(["function", "private", "storage", "uniform", "workgroup"] as const);
export const WGSL_ACCESS_MODE_NAMES: ReadonlySet<string> = new Set(["read", "read_write", "write"] as const);
export const WGSL_TEXEL_FORMAT_NAMES: ReadonlySet<string> = new Set([
  "bgra8unorm", "r32float", "r32sint", "r32uint", "rg32float", "rg32sint", "rg32uint", "rgba16float", "rgba16sint",
  "rgba16uint", "rgba32float", "rgba32sint", "rgba32uint", "rgba8sint", "rgba8snorm", "rgba8uint", "rgba8unorm",
] as const);

export const WGSL_RENAME_FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set([
  ...WGSL_KEYWORDS,
  ...WGSL_RESERVED_WORDS,
  ...WGSL_PREDECLARED_TYPES,
  ...WGSL_PREDECLARED_VALUES,
  ...WGSL_BUILTIN_VALUES,
  ...WGSL_ATTRIBUTE_NAMES,
  ...WGSL_ADDRESS_SPACE_NAMES,
  ...WGSL_ACCESS_MODE_NAMES,
  ...WGSL_TEXEL_FORMAT_NAMES,
]);

export function isWgslRenameForbiddenIdentifier(name: string): boolean {
  return WGSL_RENAME_FORBIDDEN_IDENTIFIERS.has(name);
}
