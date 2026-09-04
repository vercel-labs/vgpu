// A feasibility-only override materializer for the pinned Tint revision.
//
// Usage:
//   prototype --source <path> --source-name <virtual-path> --entry-point <name>
//     [--feature f16]
//     [--name <override-name> <bool|number|string> <payload>]...
//     [--id <explicit-wgsl-id> <bool|number|string> <payload>]...
//
// The process prints exactly one JSON result. This typed CLI is intentionally
// local to the spike; it is not a proposed worker transport.

#include <algorithm>
#include <array>
#include <bit>
#include <cerrno>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <CommonCrypto/CommonDigest.h>

#include "src/tint/api/tint.h"
#include "src/tint/lang/core/constant/eval.h"
#include "src/tint/lang/core/constant/scalar.h"
#include "src/tint/lang/core/constant/value.h"
#include "src/tint/lang/core/ir/block.h"
#include "src/tint/lang/core/ir/builder.h"
#include "src/tint/lang/core/ir/constant.h"
#include "src/tint/lang/core/ir/control_instruction.h"
#include "src/tint/lang/core/ir/function.h"
#include "src/tint/lang/core/ir/instruction_result.h"
#include "src/tint/lang/core/ir/override.h"
#include "src/tint/lang/core/ir/referenced_module_decls.h"
#include "src/tint/lang/core/ir/transform/single_entry_point.h"
#include "src/tint/lang/core/ir/transform/substitute_overrides.h"
#include "src/tint/lang/core/ir/var.h"
#include "src/tint/lang/core/type/bool.h"
#include "src/tint/lang/core/type/f16.h"
#include "src/tint/lang/core/type/f32.h"
#include "src/tint/lang/core/type/i32.h"
#include "src/tint/lang/core/type/u32.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"
#include "src/tint/utils/diagnostic/diagnostic.h"

namespace {

constexpr std::string_view kContractId =
    "vgpu-native-override-defaults-spike/v1";
constexpr std::string_view kTintRevision =
    "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";

enum class ConfigKeyKind { kName, kId };
enum class InputKind { kBool, kNumber, kString };
enum class ScalarType { kBool, kI32, kU32, kF16, kF32 };
enum class DefaultStatus { kAbsent, kUnavailable, kValue };

struct Diagnostic {
  std::string code;
  std::string phase;
  std::string message;
};

struct InputValue {
  InputKind kind = InputKind::kString;
  bool boolean = false;
  double number = 0.0;
  std::string text;
};

struct RawConfig {
  ConfigKeyKind key_kind = ConfigKeyKind::kName;
  std::string key;
  std::optional<uint16_t> id;
  InputValue input;
};

struct Arguments {
  std::string source_path;
  std::string source_name;
  std::string entry_point;
  bool enable_f16 = false;
  std::vector<RawConfig> config;
};

struct TypedValue {
  ScalarType type = ScalarType::kBool;
  bool boolean = false;
  int32_t i32 = 0;
  uint32_t u32 = 0;
  uint16_t f16_bits = 0;
  uint32_t f32_bits = 0;
};

struct DefaultEvaluation {
  DefaultStatus status = DefaultStatus::kAbsent;
  std::optional<TypedValue> value;
};

struct ReflectedOverride {
  std::string name;
  uint16_t id = 0;
  ScalarType type = ScalarType::kBool;
  bool has_initializer = false;
  bool explicit_id = false;
};

struct MaterializedOverride {
  ReflectedOverride reflected;
  DefaultEvaluation default_evaluation;
  TypedValue selected;
};

struct WorkgroupAxisEvidence {
  uint32_t resolved = 1;
  std::vector<std::string> override_dependencies;
};

struct Selection {
  InputValue input;
};

struct ResolvedConfig {
  uint16_t id = 0;
  ConfigKeyKind key_kind = ConfigKeyKind::kName;
  std::string key;
  InputValue input;
};

struct ParseArgumentsResult {
  std::optional<Arguments> arguments;
  std::optional<Diagnostic> error;
};

std::string ReadFile(const std::string &path) {
  std::ifstream stream(path, std::ios::binary);
  std::ostringstream contents;
  contents << stream.rdbuf();
  return contents.str();
}

std::optional<std::string> Sha256Hex(std::string_view value) {
  if (value.size() > std::numeric_limits<CC_LONG>::max()) {
    return std::nullopt;
  }
  std::array<unsigned char, CC_SHA256_DIGEST_LENGTH> digest{};
  if (CC_SHA256(value.data(), static_cast<CC_LONG>(value.size()),
                digest.data()) == nullptr) {
    return std::nullopt;
  }
  constexpr char kHex[] = "0123456789abcdef";
  std::string encoded;
  encoded.reserve(digest.size() * 2);
  for (const auto byte : digest) {
    encoded.push_back(kHex[byte >> 4]);
    encoded.push_back(kHex[byte & 0x0f]);
  }
  return encoded;
}

std::string JsonString(std::string_view value) {
  std::ostringstream output;
  output << '"';
  for (const unsigned char character : value) {
    switch (character) {
    case '\\':
      output << "\\\\";
      break;
    case '"':
      output << "\\\"";
      break;
    case '\b':
      output << "\\b";
      break;
    case '\f':
      output << "\\f";
      break;
    case '\n':
      output << "\\n";
      break;
    case '\r':
      output << "\\r";
      break;
    case '\t':
      output << "\\t";
      break;
    default:
      if (character < 0x20) {
        output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
               << static_cast<unsigned int>(character) << std::dec;
      } else {
        output << static_cast<char>(character);
      }
      break;
    }
  }
  output << '"';
  return output.str();
}

Diagnostic Error(std::string code, std::string phase, std::string message) {
  return Diagnostic{.code = std::move(code),
                    .phase = std::move(phase),
                    .message = std::move(message)};
}

void WriteFailure(const Diagnostic &diagnostic) {
  std::cout << "{\n"
            << "  \"schemaVersion\": 1,\n"
            << "  \"contractId\": " << JsonString(kContractId) << ",\n"
            << "  \"ok\": false,\n"
            << "  \"upstreamRevision\": " << JsonString(kTintRevision) << ",\n"
            << "  \"diagnostics\": [\n"
            << "    {\"code\": " << JsonString(diagnostic.code)
            << ", \"phase\": " << JsonString(diagnostic.phase)
            << ", \"message\": " << JsonString(diagnostic.message) << "}\n"
            << "  ]\n"
            << "}\n";
}

bool SetOnce(std::string &destination, std::string value) {
  if (!destination.empty() || value.empty()) {
    return false;
  }
  destination = std::move(value);
  return true;
}

std::optional<uint64_t> ParseUnsigned(std::string_view value) {
  if (value.empty()) {
    return std::nullopt;
  }
  uint64_t parsed = 0;
  const auto result =
      std::from_chars(value.data(), value.data() + value.size(), parsed, 10);
  if (result.ec != std::errc{} || result.ptr != value.data() + value.size()) {
    return std::nullopt;
  }
  return parsed;
}

std::optional<double> ParseNumber(std::string_view value) {
  if (value == "nan") {
    return std::numeric_limits<double>::quiet_NaN();
  }
  if (value == "inf" || value == "+inf") {
    return std::numeric_limits<double>::infinity();
  }
  if (value == "-inf") {
    return -std::numeric_limits<double>::infinity();
  }
  if (value.empty()) {
    return std::nullopt;
  }
  double parsed = 0.0;
  const auto result = std::from_chars(value.data(), value.data() + value.size(),
                                      parsed, std::chars_format::general);
  if (result.ec != std::errc{} || result.ptr != value.data() + value.size()) {
    return std::nullopt;
  }
  return parsed;
}

std::optional<InputValue> ParseInputValue(std::string_view kind,
                                          std::string payload) {
  if (kind == "bool") {
    if (payload == "true") {
      return InputValue{.kind = InputKind::kBool, .boolean = true};
    }
    if (payload == "false") {
      return InputValue{.kind = InputKind::kBool, .boolean = false};
    }
    return std::nullopt;
  }
  if (kind == "number") {
    const auto number = ParseNumber(payload);
    if (!number) {
      return std::nullopt;
    }
    return InputValue{.kind = InputKind::kNumber, .number = *number};
  }
  if (kind == "string") {
    return InputValue{.kind = InputKind::kString, .text = std::move(payload)};
  }
  return std::nullopt;
}

ParseArgumentsResult ParseArguments(int argc, char **argv) {
  Arguments arguments;
  std::set<std::string> features;
  for (int index = 1; index < argc; ++index) {
    const std::string flag = argv[index];
    if (flag == "--source" || flag == "--source-name" ||
        flag == "--entry-point") {
      if (index + 1 >= argc) {
        return {.error = Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                               flag + " requires one value")};
      }
      std::string value = argv[++index];
      std::string *destination = flag == "--source" ? &arguments.source_path
                                 : flag == "--source-name"
                                     ? &arguments.source_name
                                     : &arguments.entry_point;
      if (!SetOnce(*destination, std::move(value))) {
        return {.error =
                    Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                          flag + " must appear once with a non-empty value")};
      }
      continue;
    }
    if (flag == "--feature") {
      if (index + 1 >= argc) {
        return {.error = Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                               "--feature requires one value")};
      }
      const std::string feature = argv[++index];
      if (!features.insert(feature).second || feature != "f16") {
        return {.error = Error("VGPU-C1-OVERRIDE-FEATURE", "request",
                               "only one explicit f16 feature is supported")};
      }
      arguments.enable_f16 = true;
      continue;
    }
    if (flag == "--name" || flag == "--id") {
      if (index + 3 >= argc) {
        return {.error =
                    Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                          flag + " requires a key, value kind, and payload")};
      }
      RawConfig config;
      config.key_kind =
          flag == "--name" ? ConfigKeyKind::kName : ConfigKeyKind::kId;
      config.key = argv[++index];
      const std::string value_kind = argv[++index];
      std::string payload = argv[++index];
      if (config.key.empty()) {
        return {.error = Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                               "override config keys cannot be empty")};
      }
      if (config.key_kind == ConfigKeyKind::kId) {
        const auto parsed = ParseUnsigned(config.key);
        if (!parsed || *parsed > std::numeric_limits<uint16_t>::max()) {
          return {.error = Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                                 "override IDs must be decimal uint16 values")};
        }
        config.id = static_cast<uint16_t>(*parsed);
      }
      auto input = ParseInputValue(value_kind, std::move(payload));
      if (!input) {
        return {
            .error = Error(
                "VGPU-C1-OVERRIDE-REQUEST", "request",
                "override values use bool, number, or string payload kinds")};
      }
      config.input = std::move(*input);
      arguments.config.push_back(std::move(config));
      continue;
    }
    return {.error = Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                           "unknown argument " + flag)};
  }
  if (arguments.source_path.empty() || arguments.source_name.empty() ||
      arguments.entry_point.empty()) {
    return {.error = Error(
                "VGPU-C1-OVERRIDE-REQUEST", "request",
                "--source, --source-name, and --entry-point are required")};
  }
  return {.arguments = std::move(arguments)};
}

const char *ScalarTypeName(ScalarType type) {
  switch (type) {
  case ScalarType::kBool:
    return "bool";
  case ScalarType::kI32:
    return "i32";
  case ScalarType::kU32:
    return "u32";
  case ScalarType::kF16:
    return "f16";
  case ScalarType::kF32:
    return "f32";
  }
  return "unknown";
}

std::optional<ScalarType> InspectorType(tint::inspector::Override::Type type) {
  using Type = tint::inspector::Override::Type;
  switch (type) {
  case Type::kBool:
    return ScalarType::kBool;
  case Type::kInt32:
    return ScalarType::kI32;
  case Type::kUint32:
    return ScalarType::kU32;
  case Type::kFloat16:
    return ScalarType::kF16;
  case Type::kFloat32:
    return ScalarType::kF32;
  }
  return std::nullopt;
}

std::optional<ScalarType> IRType(const tint::core::type::Type *type) {
  if (type->Is<tint::core::type::Bool>()) {
    return ScalarType::kBool;
  }
  if (type->Is<tint::core::type::I32>()) {
    return ScalarType::kI32;
  }
  if (type->Is<tint::core::type::U32>()) {
    return ScalarType::kU32;
  }
  if (type->Is<tint::core::type::F16>()) {
    return ScalarType::kF16;
  }
  if (type->Is<tint::core::type::F32>()) {
    return ScalarType::kF32;
  }
  return std::nullopt;
}

std::optional<TypedValue>
TypedConstant(const tint::core::constant::Value *value) {
  if (const auto *scalar = value->As<tint::core::constant::Scalar<bool>>()) {
    return TypedValue{.type = ScalarType::kBool, .boolean = scalar->value};
  }
  if (const auto *scalar =
          value->As<tint::core::constant::Scalar<tint::core::i32>>()) {
    return TypedValue{.type = ScalarType::kI32, .i32 = scalar->value.value};
  }
  if (const auto *scalar =
          value->As<tint::core::constant::Scalar<tint::core::u32>>()) {
    return TypedValue{.type = ScalarType::kU32, .u32 = scalar->value.value};
  }
  if (const auto *scalar =
          value->As<tint::core::constant::Scalar<tint::core::f16>>()) {
    return TypedValue{.type = ScalarType::kF16,
                      .f16_bits = scalar->value.BitsRepresentation()};
  }
  if (const auto *scalar =
          value->As<tint::core::constant::Scalar<tint::core::f32>>()) {
    return TypedValue{.type = ScalarType::kF32,
                      .f32_bits = std::bit_cast<uint32_t>(scalar->value.value)};
  }
  return std::nullopt;
}

bool ValidateInput(const InputValue &input, const ReflectedOverride &reflected,
                   Diagnostic &diagnostic) {
  if (reflected.type == ScalarType::kBool) {
    if (input.kind != InputKind::kBool) {
      diagnostic = Error("VGPU-C1-OVERRIDE-WRONG-TYPE", "config",
                         reflected.name + " requires a boolean value");
      return false;
    }
    return true;
  }
  if (input.kind != InputKind::kNumber) {
    diagnostic = Error("VGPU-C1-OVERRIDE-WRONG-TYPE", "config",
                       reflected.name + " requires a numeric value");
    return false;
  }
  if (!std::isfinite(input.number)) {
    diagnostic = Error("VGPU-C1-OVERRIDE-NONFINITE", "config",
                       reflected.name + " requires a finite value");
    return false;
  }
  if (reflected.type == ScalarType::kI32) {
    if (std::trunc(input.number) != input.number) {
      diagnostic = Error("VGPU-C1-OVERRIDE-WRONG-TYPE", "config",
                         reflected.name + " requires an integer value");
      return false;
    }
    if (input.number < std::numeric_limits<int32_t>::min() ||
        input.number > std::numeric_limits<int32_t>::max()) {
      diagnostic = Error("VGPU-C1-OVERRIDE-OUT-OF-RANGE", "config",
                         reflected.name + " is outside the i32 range");
      return false;
    }
    return true;
  }
  if (reflected.type == ScalarType::kU32) {
    if (std::trunc(input.number) != input.number) {
      diagnostic = Error("VGPU-C1-OVERRIDE-WRONG-TYPE", "config",
                         reflected.name + " requires an integer value");
      return false;
    }
    if (input.number < 0 ||
        input.number > std::numeric_limits<uint32_t>::max()) {
      diagnostic = Error("VGPU-C1-OVERRIDE-OUT-OF-RANGE", "config",
                         reflected.name + " is outside the u32 range");
      return false;
    }
    return true;
  }
  if (reflected.type == ScalarType::kF32) {
    if (input.number < static_cast<double>(tint::core::f32::kLowestValue) ||
        input.number > static_cast<double>(tint::core::f32::kHighestValue)) {
      diagnostic = Error("VGPU-C1-OVERRIDE-OUT-OF-RANGE", "config",
                         reflected.name + " is outside the finite f32 range");
      return false;
    }
    return true;
  }
  if (input.number < static_cast<double>(tint::core::f16::kLowestValue) ||
      input.number > static_cast<double>(tint::core::f16::kHighestValue)) {
    diagnostic = Error("VGPU-C1-OVERRIDE-OUT-OF-RANGE", "config",
                       reflected.name + " is outside the finite f16 range");
    return false;
  }
  return true;
}

double TintSubstitutionValue(const TypedValue &value) {
  switch (value.type) {
  case ScalarType::kBool:
    return value.boolean ? 1.0 : 0.0;
  case ScalarType::kI32:
    return static_cast<double>(value.i32);
  case ScalarType::kU32:
    return static_cast<double>(value.u32);
  case ScalarType::kF16:
    return static_cast<double>(tint::core::f16::FromBits(value.f16_bits).value);
  case ScalarType::kF32:
    return static_cast<double>(std::bit_cast<float>(value.f32_bits));
  }
  return 0.0;
}

tint::core::ir::Constant *MakeIRConstant(tint::core::ir::Builder &builder,
                                         const TypedValue &value) {
  switch (value.type) {
  case ScalarType::kBool:
    return builder.Constant(value.boolean);
  case ScalarType::kI32:
    return builder.Constant(tint::core::i32{value.i32});
  case ScalarType::kU32:
    return builder.Constant(tint::core::u32{value.u32});
  case ScalarType::kF16:
    return builder.Constant(tint::core::f16::FromBits(value.f16_bits));
  case ScalarType::kF32:
    return builder.Constant(
        tint::core::f32{std::bit_cast<float>(value.f32_bits)});
  }
  return nullptr;
}

bool SameTypedValue(const TypedValue &left, const TypedValue &right) {
  if (left.type != right.type) {
    return false;
  }
  switch (left.type) {
  case ScalarType::kBool:
    return left.boolean == right.boolean;
  case ScalarType::kI32:
    return left.i32 == right.i32;
  case ScalarType::kU32:
    return left.u32 == right.u32;
  case ScalarType::kF16:
    return left.f16_bits == right.f16_bits;
  case ScalarType::kF32:
    return left.f32_bits == right.f32_bits;
  }
  return false;
}

std::map<uint16_t, tint::core::ir::Var *> AddOverrideProbes(
    tint::core::ir::Module &module,
    const std::map<uint16_t, tint::core::ir::Override *> &overrides,
    Diagnostic &diagnostic) {
  std::map<uint16_t, tint::core::ir::Var *> probes;
  if (module.root_block == nullptr) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "Tint IR has no root block for override probes");
    return probes;
  }
  tint::core::ir::Builder builder(module);
  builder.Append(module.root_block, [&] {
    for (const auto &[id, item] : overrides) {
      auto *probe = builder.Var<tint::core::AddressSpace::kPrivate>(
          "__vgpu_override_probe_" + std::to_string(id), item->Result());
      if (probe == nullptr || !probes.emplace(id, probe).second) {
        diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                           "failed to create a unique override probe");
        return;
      }
    }
  });
  return probes;
}

std::optional<std::map<uint16_t, TypedValue>>
ReadOverrideProbes(const std::map<uint16_t, tint::core::ir::Var *> &probes,
                   Diagnostic &diagnostic) {
  std::map<uint16_t, TypedValue> values;
  for (const auto &[id, probe] : probes) {
    const auto *initializer = probe->Initializer();
    const auto *constant = initializer == nullptr
                               ? nullptr
                               : initializer->As<tint::core::ir::Constant>();
    const auto value =
        constant == nullptr ? std::nullopt : TypedConstant(constant->Value());
    if (!value || !values.emplace(id, *value).second) {
      diagnostic = Error(
          "VGPU-C1-OVERRIDE-INTERNAL", "internal",
          "SubstituteOverrides did not materialize a typed probe constant");
      return std::nullopt;
    }
  }
  return values;
}

std::optional<TypedValue>
ConvertInputWithTint(tint::core::ir::Module &module,
                     const tint::core::ir::Override &override,
                     const InputValue &input, Diagnostic &diagnostic) {
  const tint::core::constant::Value *source_value = nullptr;
  if (input.kind == InputKind::kBool) {
    source_value = module.constant_values.Get(input.boolean);
  } else if (input.kind == InputKind::kNumber) {
    source_value = module.constant_values.Get(tint::core::AFloat{input.number});
  } else {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "validated override input has an unsupported kind");
    return std::nullopt;
  }

  tint::diag::List diagnostics;
  tint::core::constant::Eval evaluator(module.constant_values, diagnostics);
  auto converted = evaluator.Convert(override.Result()->Type(), source_value,
                                     tint::Source{});
  if (converted != tint::Success || converted.Get() == nullptr) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "Tint rejected a validated override conversion");
    return std::nullopt;
  }
  auto value = TypedConstant(converted.Get());
  if (!value) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "Tint produced a non-scalar override conversion");
    return std::nullopt;
  }
  return value;
}

std::map<uint16_t, tint::core::ir::Override *>
CollectIROverrides(tint::core::ir::Module &module, Diagnostic &diagnostic) {
  std::map<uint16_t, tint::core::ir::Override *> output;
  if (module.root_block == nullptr) {
    return output;
  }
  for (auto *instruction : *module.root_block) {
    auto *item = instruction->As<tint::core::ir::Override>();
    if (item == nullptr) {
      continue;
    }
    if (!item->OverrideId() ||
        !output.emplace(item->OverrideId()->value, item).second) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "Tint IR produced a missing or duplicate override ID");
      return {};
    }
  }
  return output;
}

bool CrossCheckIRSubset(tint::core::ir::Module &module,
                        const std::vector<ReflectedOverride> &reflected,
                        std::map<uint16_t, tint::core::ir::Override *> &output,
                        Diagnostic &diagnostic) {
  output = CollectIROverrides(module, diagnostic);
  if (!diagnostic.code.empty()) {
    return false;
  }
  std::map<uint16_t, const ReflectedOverride *> reflected_by_id;
  for (const auto &item : reflected) {
    reflected_by_id.emplace(item.id, &item);
  }
  for (const auto &[id, ir_override] : output) {
    const auto found = reflected_by_id.find(id);
    if (found == reflected_by_id.end() ||
        module.NameOf(ir_override).NameView() != found->second->name ||
        IRType(ir_override->Result()->Type()) != found->second->type ||
        (ir_override->Initializer() != nullptr) !=
            found->second->has_initializer) {
      diagnostic =
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "Tint IR override is not authorized by Inspector reflection");
      return false;
    }
  }
  return true;
}

void CollectOverrideDependencies(
    const tint::core::ir::Value *value,
    std::set<const tint::core::ir::Value *> &visited,
    std::set<uint16_t> &dependencies) {
  if (value == nullptr || !visited.insert(value).second) {
    return;
  }
  const auto *result = value->As<tint::core::ir::InstructionResult>();
  if (result == nullptr || result->Instruction() == nullptr) {
    return;
  }
  const auto *instruction = result->Instruction();
  if (const auto *item = instruction->As<tint::core::ir::Override>()) {
    if (item->OverrideId()) {
      dependencies.insert(item->OverrideId()->value);
    }
  }
  for (const auto *operand : instruction->Operands()) {
    CollectOverrideDependencies(operand, visited, dependencies);
  }
  if (const auto *control =
          instruction->As<tint::core::ir::ControlInstruction>()) {
    control->ForeachBlock([&](const tint::core::ir::Block *block) {
      for (const auto *nested : *block) {
        for (const auto *operand : nested->Operands()) {
          CollectOverrideDependencies(operand, visited, dependencies);
        }
      }
    });
  }
}

std::set<uint16_t> OverrideDependencies(const tint::core::ir::Value *value) {
  std::set<const tint::core::ir::Value *> visited;
  std::set<uint16_t> dependencies;
  CollectOverrideDependencies(value, visited, dependencies);
  return dependencies;
}

tint::core::ir::Function *FindEntryFunction(tint::core::ir::Module &module,
                                            std::string_view name) {
  tint::core::ir::Function *result = nullptr;
  for (auto *function : module.functions) {
    if (function->IsEntryPoint() &&
        module.NameOf(function).NameView() == name) {
      if (result != nullptr) {
        return nullptr;
      }
      result = function;
    }
  }
  return result;
}

const char *PipelineStageName(tint::inspector::PipelineStage stage) {
  switch (stage) {
  case tint::inspector::PipelineStage::kVertex:
    return "vertex";
  case tint::inspector::PipelineStage::kFragment:
    return "fragment";
  case tint::inspector::PipelineStage::kCompute:
    return "compute";
  }
  return "unknown";
}

void WriteTypedValue(std::ostream &output, const TypedValue &value) {
  output << "{\"type\": " << JsonString(ScalarTypeName(value.type));
  switch (value.type) {
  case ScalarType::kBool:
    output << ", \"value\": " << (value.boolean ? "true" : "false");
    break;
  case ScalarType::kI32:
    output << ", \"value\": " << value.i32;
    break;
  case ScalarType::kU32:
    output << ", \"value\": " << value.u32;
    break;
  case ScalarType::kF16:
    output << ", \"bits\": \"" << std::hex << std::setw(4) << std::setfill('0')
           << value.f16_bits << std::dec << '"';
    break;
  case ScalarType::kF32:
    output << ", \"bits\": \"" << std::hex << std::setw(8) << std::setfill('0')
           << value.f32_bits << std::dec << '"';
    break;
  }
  output << '}';
}

void WriteMaterializedOverrides(
    std::ostream &output,
    const std::vector<MaterializedOverride> &materialized) {
  output << '[';
  if (!materialized.empty()) {
    output << '\n';
  }
  for (size_t index = 0; index < materialized.size(); ++index) {
    const auto &item = materialized[index];
    output << "    {\"name\": " << JsonString(item.reflected.name)
           << ", \"id\": {\"value\": " << item.reflected.id << ", \"kind\": "
           << JsonString(item.reflected.explicit_id ? "explicit" : "auto")
           << "}, \"type\": " << JsonString(ScalarTypeName(item.reflected.type))
           << ", \"initializer\": "
           << JsonString(item.reflected.has_initializer ? "present" : "absent")
           << ", \"defaultEvaluation\": {\"status\": ";
    switch (item.default_evaluation.status) {
    case DefaultStatus::kAbsent:
      output << JsonString("absent");
      break;
    case DefaultStatus::kUnavailable:
      output << JsonString("unavailable")
             << ", \"reason\": " << JsonString("requires-configuration");
      break;
    case DefaultStatus::kValue:
      output << JsonString("value") << ", \"value\": ";
      WriteTypedValue(output, *item.default_evaluation.value);
      break;
    }
    output << "}, \"selected\": ";
    WriteTypedValue(output, item.selected);
    output << '}' << (index + 1 == materialized.size() ? "\n" : ",\n");
  }
  output << "  ]";
}

void WriteSuccess(
    const Arguments &arguments, tint::inspector::PipelineStage stage,
    std::string_view source_sha256,
    const std::vector<MaterializedOverride> &static_materialized,
    const std::vector<MaterializedOverride> &effective_materialized,
    const std::optional<std::array<WorkgroupAxisEvidence, 3>> &workgroup_axes) {
  std::ostringstream output;
  output << "{\n"
         << "  \"schemaVersion\": 1,\n"
         << "  \"contractId\": " << JsonString(kContractId) << ",\n"
         << "  \"ok\": true,\n"
         << "  \"upstreamRevision\": " << JsonString(kTintRevision) << ",\n"
         << "  \"sourceName\": " << JsonString(arguments.source_name) << ",\n"
         << "  \"sourceSha256\": " << JsonString(source_sha256) << ",\n"
         << "  \"entryPoint\": {\"name\": " << JsonString(arguments.entry_point)
         << ", \"stage\": " << JsonString(PipelineStageName(stage)) << "},\n"
         << "  \"staticOverrides\": ";
  WriteMaterializedOverrides(output, static_materialized);
  output << ",\n  \"overrides\": ";
  WriteMaterializedOverrides(output, effective_materialized);
  output << ",\n"
         << "  \"verification\": {\"singleEntryPoint\": true, "
            "\"substituteOverrides\": true, "
            "\"fullActiveMapAccepted\": true, "
            "\"exactStaticOverrideCount\": "
         << static_materialized.size() << ", "
         << "\"verifiedOverrideCount\": " << effective_materialized.size();
  if (workgroup_axes) {
    output << ", \"workgroupSize\": [" << (*workgroup_axes)[0].resolved << ", "
           << (*workgroup_axes)[1].resolved << ", "
           << (*workgroup_axes)[2].resolved << "], \"workgroupSizeAxes\": [";
    for (size_t axis_index = 0; axis_index < workgroup_axes->size();
         ++axis_index) {
      const auto &axis = (*workgroup_axes)[axis_index];
      output << "{\"resolved\": " << axis.resolved << ", \"kind\": "
             << JsonString(axis.override_dependencies.empty()
                               ? "literal"
                               : "override-expression")
             << ", \"overrides\": [";
      for (size_t dependency_index = 0;
           dependency_index < axis.override_dependencies.size();
           ++dependency_index) {
        output << JsonString(axis.override_dependencies[dependency_index]);
        if (dependency_index + 1 != axis.override_dependencies.size()) {
          output << ", ";
        }
      }
      output << "]}";
      if (axis_index + 1 != workgroup_axes->size()) {
        output << ", ";
      }
    }
    output << ']';
  }
  output << "}\n}\n";
  std::cout << output.str();
}

int Run(int argc, char **argv) {
  const auto parsed_arguments = ParseArguments(argc, argv);
  if (parsed_arguments.error) {
    WriteFailure(*parsed_arguments.error);
    return 2;
  }
  const Arguments &arguments = *parsed_arguments.arguments;
  const std::string source_text = ReadFile(arguments.source_path);
  if (source_text.empty()) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                       "the WGSL source is empty or unreadable"));
    return 2;
  }
  const auto source_sha256 = Sha256Hex(source_text);
  if (!source_sha256) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                       "the WGSL source is too large to hash"));
    return 2;
  }

  tint::Source::File source_file(arguments.source_name, source_text);
  tint::wgsl::reader::Options reader_options;
  if (arguments.enable_f16) {
    reader_options.allowed_features.extensions.insert(
        tint::wgsl::Extension::kF16);
  }
  auto program = tint::wgsl::reader::Parse(&source_file, reader_options);
  if (!program.IsValid()) {
    WriteFailure(
        Error("VGPU-C1-OVERRIDE-WGSL", "wgsl", program.Diagnostics().Str()));
    return 1;
  }

  tint::inspector::Inspector inspector(program);
  const auto all_inspected = inspector.Overrides();
  const auto entry = inspector.GetEntryPoint(arguments.entry_point);
  if (inspector.has_error()) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-ENTRY", "inspect", inspector.error()));
    return 1;
  }

  std::map<uint16_t, ReflectedOverride> all_by_id;
  std::map<std::string, uint16_t> all_by_name;
  std::map<uint16_t, ReflectedOverride> active_by_id;
  for (const auto &inspected : all_inspected) {
    const auto type = InspectorType(inspected.type);
    if (!type) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "Inspector returned an unsupported override type"));
      return 1;
    }
    ReflectedOverride reflected{
        .name = inspected.name,
        .id = inspected.id.value,
        .type = *type,
        .has_initializer = inspected.is_initialized,
        .explicit_id = inspected.is_id_specified,
    };
    if (!all_by_id.emplace(reflected.id, reflected).second ||
        !all_by_name.emplace(reflected.name, reflected.id).second) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "Inspector returned duplicate override identity"));
      return 1;
    }
  }
  for (const auto &inspected : entry.overrides) {
    const auto found = all_by_id.find(inspected.id.value);
    if (found == all_by_id.end() ||
        !active_by_id.emplace(found->first, found->second).second) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "entry reflection disagrees with module overrides"));
      return 1;
    }
  }

  std::vector<ResolvedConfig> resolved_configs;
  std::vector<std::pair<std::string, Diagnostic>> resolution_errors;
  for (const auto &config : arguments.config) {
    std::optional<uint16_t> resolved_id;
    if (config.key_kind == ConfigKeyKind::kName) {
      const auto found = all_by_name.find(config.key);
      if (found != all_by_name.end()) {
        resolved_id = found->second;
      }
    } else {
      for (const auto &[id, reflected] : all_by_id) {
        if (reflected.explicit_id && config.id == id) {
          resolved_id = id;
          break;
        }
      }
    }
    if (!resolved_id) {
      const std::string canonical_key =
          config.key_kind == ConfigKeyKind::kName
              ? "name:" + config.key
              : "id:" + std::to_string(*config.id);
      const std::string display_key = config.key_kind == ConfigKeyKind::kName
                                          ? config.key
                                          : std::to_string(*config.id);
      resolution_errors.emplace_back(
          canonical_key, Error("VGPU-C1-OVERRIDE-UNKNOWN", "config",
                               "override config key " + display_key +
                                   " matches no declaration"));
      continue;
    }
    resolved_configs.push_back(ResolvedConfig{.id = *resolved_id,
                                              .key_kind = config.key_kind,
                                              .key = config.key,
                                              .input = config.input});
  }
  if (!resolution_errors.empty()) {
    std::sort(resolution_errors.begin(), resolution_errors.end(),
              [](const auto &left, const auto &right) {
                return left.first < right.first;
              });
    WriteFailure(resolution_errors.front().second);
    return 1;
  }

  std::sort(resolved_configs.begin(), resolved_configs.end(),
            [](const ResolvedConfig &left, const ResolvedConfig &right) {
              if (left.id != right.id) {
                return left.id < right.id;
              }
              if (left.key_kind != right.key_kind) {
                return left.key_kind < right.key_kind;
              }
              return left.key < right.key;
            });
  std::map<uint16_t, Selection> selections;
  for (size_t index = 0; index < resolved_configs.size();) {
    size_t end = index + 1;
    while (end < resolved_configs.size() &&
           resolved_configs[end].id == resolved_configs[index].id) {
      ++end;
    }
    const auto &config = resolved_configs[index];
    const auto &reflected = all_by_id.at(config.id);
    if (end - index > 1) {
      bool has_name = false;
      bool has_id = false;
      for (size_t duplicate = index; duplicate < end; ++duplicate) {
        has_name |=
            resolved_configs[duplicate].key_kind == ConfigKeyKind::kName;
        has_id |= resolved_configs[duplicate].key_kind == ConfigKeyKind::kId;
      }
      if (has_name && has_id) {
        WriteFailure(Error("VGPU-C1-OVERRIDE-ID-NAME-CONFLICT", "config",
                           "override " + reflected.name +
                               " was configured by both name and explicit ID"));
      } else {
        WriteFailure(
            Error("VGPU-C1-OVERRIDE-DUPLICATE-CONFIG", "config",
                  "override " + reflected.name + " appears more than once"));
      }
      return 1;
    }
    Diagnostic conversion_error;
    if (!ValidateInput(config.input, reflected, conversion_error)) {
      WriteFailure(conversion_error);
      return 1;
    }
    selections.emplace(config.id, Selection{.input = config.input});
    index = end;
  }

  std::vector<ReflectedOverride> inspected_all;
  inspected_all.reserve(all_by_id.size());
  for (const auto &[id, reflected] : all_by_id) {
    static_cast<void>(id);
    inspected_all.push_back(reflected);
  }
  std::vector<ReflectedOverride> inspected_active;
  inspected_active.reserve(active_by_id.size());
  for (const auto &[id, reflected] : active_by_id) {
    static_cast<void>(id);
    inspected_active.push_back(reflected);
  }
  auto static_active = inspected_active;
  std::sort(static_active.begin(), static_active.end(),
            [](const ReflectedOverride &left, const ReflectedOverride &right) {
              return left.name < right.name;
            });

  // Pipeline-overridable constants without initializers are required by the
  // statically active entry-point interface. Validate them before any IR
  // folding or configured-initializer cuts: those transformations can remove
  // the declaration from the effective evidence graph, but they cannot make a
  // missing API value valid.
  for (const auto &[id, reflected] : active_by_id) {
    if (!reflected.has_initializer && !selections.contains(id)) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-MISSING-REQUIRED", "materialize",
                         "active override " + reflected.name +
                             " has no initializer and must be configured"));
      return 1;
    }
  }

  // Apply explicit selections before SingleEntryPoint. WGSL does not evaluate
  // the initializer of a directly configured override. This cuts
  // initializer-only dependencies from the effective evidence graph after the
  // static required-value check above.
  auto selected_ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (selected_ir_result != tint::Success) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-IR", "materialize",
                       selected_ir_result.Failure().reason));
    return 1;
  }
  auto &selected_ir = selected_ir_result.Get();
  std::map<uint16_t, tint::core::ir::Override *> selected_ir_overrides;
  Diagnostic internal_error;
  if (!CrossCheckIRSubset(selected_ir, inspected_all, selected_ir_overrides,
                          internal_error)) {
    WriteFailure(internal_error);
    return 1;
  }
  tint::core::ir::Builder selected_builder(selected_ir);
  std::map<uint16_t, TypedValue> normalized_selections;
  for (const auto &[id, selection] : selections) {
    Diagnostic conversion_error;
    auto normalized =
        ConvertInputWithTint(selected_ir, *selected_ir_overrides.at(id),
                             selection.input, conversion_error);
    if (!normalized || normalized->type != all_by_id.at(id).type) {
      WriteFailure(conversion_error.code.empty()
                       ? Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                               "Tint conversion returned the wrong scalar type")
                       : conversion_error);
      return 1;
    }
    auto *constant = MakeIRConstant(selected_builder, *normalized);
    if (constant == nullptr) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "failed to create a typed selection constant"));
      return 1;
    }
    const auto canonical = TypedConstant(constant->Value());
    if (!canonical || canonical->type != all_by_id.at(id).type) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "Tint selection constant has the wrong scalar type"));
      return 1;
    }
    normalized_selections.emplace(id, *canonical);
    selected_ir_overrides.at(id)->SetInitializer(constant);
  }

  auto selected_single_entry = tint::core::ir::transform::SingleEntryPoint(
      selected_ir, arguments.entry_point);
  if (selected_single_entry != tint::Success) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-SINGLE-ENTRY", "materialize",
                       selected_single_entry.Failure().reason));
    return 1;
  }

  internal_error = {};
  const auto effective_ir_overrides =
      CollectIROverrides(selected_ir, internal_error);
  if (!internal_error.code.empty()) {
    WriteFailure(internal_error);
    return 1;
  }
  for (const auto &[id, item] : effective_ir_overrides) {
    const auto reflected = active_by_id.find(id);
    if (reflected == active_by_id.end() ||
        selected_ir.NameOf(item).NameView() != reflected->second.name ||
        IRType(item->Result()->Type()) != reflected->second.type) {
      WriteFailure(
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "configured SingleEntryPoint produced an unknown override"));
      return 1;
    }
  }

  // SetInitializer cuts the initializer of a directly configured override.
  // SingleEntryPoint therefore identifies which explicit configs remain in
  // the canonical effective evidence. This set is deliberately not used to
  // decide whether a statically required API value may be omitted.
  std::set<uint16_t> relevant_selection_ids;
  for (const auto &[id, selection] : selections) {
    static_cast<void>(selection);
    if (!effective_ir_overrides.contains(id)) {
      continue;
    }
    relevant_selection_ids.insert(id);
  }

  std::set<uint16_t> active_ids;
  std::set<uint16_t> effective_ir_ids;
  for (const auto &[id, item] : effective_ir_overrides) {
    const auto reflected = active_by_id.find(id);
    if (reflected == active_by_id.end() ||
        selected_ir.NameOf(item).NameView() != reflected->second.name ||
        IRType(item->Result()->Type()) != reflected->second.type) {
      WriteFailure(
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "configured SingleEntryPoint produced an unknown override"));
      return 1;
    }
    effective_ir_ids.insert(id);
    active_ids.insert(id);
  }
  std::vector<ReflectedOverride> active;
  active.reserve(active_ids.size());
  for (const auto id : active_ids) {
    active.push_back(all_by_id.at(id));
  }
  std::sort(active.begin(), active.end(),
            [](const ReflectedOverride &left, const ReflectedOverride &right) {
              return left.name < right.name;
            });

  std::optional<std::array<std::vector<std::string>, 3>>
      workgroup_dependency_names;
  auto *selected_entry = FindEntryFunction(selected_ir, arguments.entry_point);
  if (selected_entry == nullptr) {
    WriteFailure(
        Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
              "configured Tint IR did not contain exactly one selected entry"));
    return 1;
  }
  if (selected_entry->IsCompute()) {
    const auto selected_workgroup_size = selected_entry->WorkgroupSize();
    if (!selected_workgroup_size) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "compute entry has no selected workgroup size"));
      return 1;
    }
    workgroup_dependency_names.emplace();
    for (size_t axis = 0; axis < selected_workgroup_size->size(); ++axis) {
      for (const auto dependency :
           OverrideDependencies((*selected_workgroup_size)[axis])) {
        if (!active_ids.contains(dependency)) {
          WriteFailure(Error(
              "VGPU-C1-OVERRIDE-INTERNAL", "internal",
              "selected workgroup expression references an inactive override"));
          return 1;
        }
        (*workgroup_dependency_names)[axis].push_back(
            all_by_id.at(dependency).name);
      }
      std::sort((*workgroup_dependency_names)[axis].begin(),
                (*workgroup_dependency_names)[axis].end());
    }
  }

  internal_error = {};
  const auto selected_probes =
      AddOverrideProbes(selected_ir, effective_ir_overrides, internal_error);
  if (!internal_error.code.empty()) {
    WriteFailure(internal_error);
    return 1;
  }
  tint::SubstituteOverridesConfig selected_substitution;
  const auto selected_substituted =
      tint::core::ir::transform::SubstituteOverrides(selected_ir,
                                                     selected_substitution);
  if (selected_substituted != tint::Success) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-INVALID-INITIALIZER", "materialize",
                       "Tint could not materialize the selected overrides"));
    return 1;
  }
  internal_error = {};
  auto selected_probe_values =
      ReadOverrideProbes(selected_probes, internal_error);
  if (!selected_probe_values) {
    WriteFailure(internal_error);
    return 1;
  }
  std::map<uint16_t, TypedValue> selected_values;
  for (const auto id : relevant_selection_ids) {
    selected_values.emplace(id, normalized_selections.at(id));
  }
  for (const auto &[id, value] : *selected_probe_values) {
    const auto [existing, inserted] = selected_values.emplace(id, value);
    if (!inserted && !SameTypedValue(existing->second, value)) {
      WriteFailure(Error(
          "VGPU-C1-OVERRIDE-INTERNAL", "internal",
          "configured override probe disagrees with its normalized value"));
      return 1;
    }
  }
  if (selected_values.size() != active_ids.size()) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "selected override probes produced an incomplete map"));
    return 1;
  }
  for (const auto &reflected : active) {
    const auto selected = selected_values.find(reflected.id);
    if (selected == selected_values.end() ||
        selected->second.type != reflected.type) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "selected override probe has the wrong identity"));
      return 1;
    }
    const auto configured = normalized_selections.find(reflected.id);
    if (relevant_selection_ids.contains(reflected.id) &&
        (configured == normalized_selections.end() ||
         !SameTypedValue(configured->second, selected->second))) {
      WriteFailure(Error(
          "VGPU-C1-OVERRIDE-INTERNAL", "internal",
          "selected override probe disagrees with Tint input conversion"));
      return 1;
    }
  }

  // Materialize the exact static entry-point interface separately from the
  // effective closure above. Every reflected static override is a root of the
  // retained declaration union, so configured initializer cuts may remove
  // dependency edges without removing values required by the compiler request
  // or semantic artifact.
  auto static_ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (static_ir_result != tint::Success) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-IR", "materialize",
                       static_ir_result.Failure().reason));
    return 1;
  }
  auto &static_ir = static_ir_result.Get();
  std::map<uint16_t, tint::core::ir::Override *> static_ir_overrides;
  internal_error = {};
  if (!CrossCheckIRSubset(static_ir, inspected_all, static_ir_overrides,
                          internal_error) ||
      static_ir_overrides.size() != all_by_id.size()) {
    if (internal_error.code.empty()) {
      internal_error =
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "Tint IR omitted a module override reflected by Inspector");
    }
    WriteFailure(internal_error);
    return 1;
  }
  for (const auto &[id, reflected] : active_by_id) {
    static_cast<void>(reflected);
    if (!static_ir_overrides.contains(id)) {
      WriteFailure(Error(
          "VGPU-C1-OVERRIDE-INTERNAL", "internal",
          "Tint IR omitted a static override reflected for the entry point"));
      return 1;
    }
  }

  tint::core::ir::Builder static_builder(static_ir);
  for (const auto &[id, value] : normalized_selections) {
    auto *constant = MakeIRConstant(static_builder, value);
    if (constant == nullptr) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "failed to recreate a typed static selection"));
      return 1;
    }
    static_ir_overrides.at(id)->SetInitializer(constant);
  }

  tint::core::ir::ReferencedModuleDecls<tint::core::ir::Module>
      static_referenced_declarations(static_ir);
  tint::core::ir::ReferencedModuleDecls<tint::core::ir::Module>::DeclSet
      static_closure;
  for (const auto &[id, reflected] : active_by_id) {
    static_cast<void>(reflected);
    auto *target = static_ir_overrides.at(id);
    static_referenced_declarations.AddToBlock(static_closure, target);
    if (!static_closure.Contains(target)) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "static declaration closure omitted its root"));
      return 1;
    }
  }

  std::vector<tint::core::ir::Function *> static_functions;
  for (auto *function : static_ir.functions) {
    static_functions.push_back(function);
  }
  for (auto *function : static_functions) {
    static_ir.Destroy(function);
  }
  std::vector<tint::core::ir::Instruction *> static_root_instructions;
  for (auto *instruction : *static_ir.root_block) {
    static_root_instructions.push_back(instruction);
  }
  for (auto instruction = static_root_instructions.rbegin();
       instruction != static_root_instructions.rend(); ++instruction) {
    if (!static_closure.Contains(*instruction)) {
      (*instruction)->Destroy();
    }
  }

  internal_error = {};
  const auto retained_static_overrides =
      CollectIROverrides(static_ir, internal_error);
  if (!internal_error.code.empty()) {
    WriteFailure(internal_error);
    return 1;
  }
  std::set<uint16_t> static_ids;
  for (const auto &[id, reflected] : active_by_id) {
    static_cast<void>(reflected);
    static_ids.insert(id);
  }
  std::set<uint16_t> retained_static_ids;
  for (const auto &[id, item] : retained_static_overrides) {
    const auto reflected = active_by_id.find(id);
    if (reflected == active_by_id.end() ||
        static_ir.NameOf(item).NameView() != reflected->second.name ||
        IRType(item->Result()->Type()) != reflected->second.type) {
      WriteFailure(Error(
          "VGPU-C1-OVERRIDE-INTERNAL", "internal",
          "static declaration closure disagrees with Inspector reflection"));
      return 1;
    }
    retained_static_ids.insert(id);
  }
  if (retained_static_ids != static_ids) {
    WriteFailure(Error(
        "VGPU-C1-OVERRIDE-INTERNAL", "internal",
        "static declaration closure is not the exact reflected interface"));
    return 1;
  }

  internal_error = {};
  const auto static_probes =
      AddOverrideProbes(static_ir, retained_static_overrides, internal_error);
  if (!internal_error.code.empty()) {
    WriteFailure(internal_error);
    return 1;
  }
  tint::SubstituteOverridesConfig static_substitution;
  const auto static_substituted =
      tint::core::ir::transform::SubstituteOverrides(static_ir,
                                                     static_substitution);
  if (static_substituted != tint::Success) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-INVALID-INITIALIZER", "materialize",
                       "Tint could not materialize the static overrides"));
    return 1;
  }
  internal_error = {};
  auto static_probe_values = ReadOverrideProbes(static_probes, internal_error);
  if (!static_probe_values) {
    WriteFailure(internal_error);
    return 1;
  }
  if (static_probe_values->size() != static_ids.size()) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "static override probes produced an incomplete map"));
    return 1;
  }
  for (const auto &reflected : static_active) {
    const auto selected = static_probe_values->find(reflected.id);
    if (selected == static_probe_values->end() ||
        selected->second.type != reflected.type) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "static override probe has the wrong identity"));
      return 1;
    }
    const auto configured = normalized_selections.find(reflected.id);
    if (configured != normalized_selections.end() &&
        !SameTypedValue(configured->second, selected->second)) {
      WriteFailure(
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "static override probe disagrees with Tint input conversion"));
      return 1;
    }
  }
  for (const auto &[id, value] : selected_values) {
    const auto static_value = static_probe_values->find(id);
    if (static_value == static_probe_values->end() ||
        !SameTypedValue(value, static_value->second)) {
      WriteFailure(
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "effective and static selected override values disagree"));
      return 1;
    }
  }

  // Evaluate declared defaults on a fresh, unconfigured IR isolated to one
  // static override at a time. A failed default remains unavailable: a direct
  // selection may legally bypass that initializer. The selected passes above
  // are the validity oracle for omitted overrides.
  std::map<uint16_t, DefaultEvaluation> defaults;
  for (const auto &reflected : static_active) {
    if (!reflected.has_initializer) {
      defaults.emplace(reflected.id,
                       DefaultEvaluation{.status = DefaultStatus::kAbsent});
      continue;
    }
    auto default_ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
    if (default_ir_result != tint::Success) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-IR", "materialize",
                         default_ir_result.Failure().reason));
      return 1;
    }
    auto &default_ir = default_ir_result.Get();
    std::map<uint16_t, tint::core::ir::Override *> default_ir_overrides;
    internal_error = {};
    if (!CrossCheckIRSubset(default_ir, inspected_all, default_ir_overrides,
                            internal_error) ||
        default_ir_overrides.size() != all_by_id.size()) {
      if (internal_error.code.empty()) {
        internal_error =
            Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                  "default evaluation IR omitted an Inspector override");
      }
      WriteFailure(internal_error);
      return 1;
    }
    const auto target = default_ir_overrides.find(reflected.id);
    if (target == default_ir_overrides.end() ||
        target->second->Initializer() == nullptr) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "default pass lost a reflected initializer"));
      return 1;
    }
    tint::core::ir::ReferencedModuleDecls<tint::core::ir::Module>
        referenced_declarations(default_ir);
    tint::core::ir::ReferencedModuleDecls<tint::core::ir::Module>::DeclSet
        target_closure;
    referenced_declarations.AddToBlock(target_closure, target->second);
    if (!target_closure.Contains(target->second)) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "default closure omitted its target override"));
      return 1;
    }

    std::vector<tint::core::ir::Function *> default_functions;
    for (auto *function : default_ir.functions) {
      default_functions.push_back(function);
    }
    for (auto *function : default_functions) {
      default_ir.Destroy(function);
    }

    std::vector<tint::core::ir::Instruction *> default_root_instructions;
    for (auto *instruction : *default_ir.root_block) {
      default_root_instructions.push_back(instruction);
    }
    for (auto instruction = default_root_instructions.rbegin();
         instruction != default_root_instructions.rend(); ++instruction) {
      if (!target_closure.Contains(*instruction)) {
        (*instruction)->Destroy();
      }
    }
    std::map<uint16_t, tint::core::ir::Override *> target_override{
        {reflected.id, target->second}};
    internal_error = {};
    const auto default_probes =
        AddOverrideProbes(default_ir, target_override, internal_error);
    if (!internal_error.code.empty()) {
      WriteFailure(internal_error);
      return 1;
    }
    tint::SubstituteOverridesConfig default_substitution;
    const auto default_substituted =
        tint::core::ir::transform::SubstituteOverrides(default_ir,
                                                       default_substitution);
    if (default_substituted != tint::Success) {
      defaults.emplace(
          reflected.id,
          DefaultEvaluation{.status = DefaultStatus::kUnavailable});
      continue;
    }
    internal_error = {};
    const auto default_probe_values =
        ReadOverrideProbes(default_probes, internal_error);
    if (!default_probe_values) {
      WriteFailure(internal_error);
      return 1;
    }
    const auto value = default_probe_values->find(reflected.id);
    if (value == default_probe_values->end() ||
        value->second.type != reflected.type) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "default probe returned the wrong scalar type"));
      return 1;
    }
    defaults.emplace(reflected.id,
                     DefaultEvaluation{.status = DefaultStatus::kValue,
                                       .value = value->second});
  }

  std::vector<MaterializedOverride> materialized;
  materialized.reserve(active.size());
  for (const auto &reflected : active) {
    materialized.push_back(MaterializedOverride{
        .reflected = reflected,
        .default_evaluation = defaults.at(reflected.id),
        .selected = selected_values.at(reflected.id),
    });
  }
  std::vector<MaterializedOverride> static_materialized;
  static_materialized.reserve(static_active.size());
  for (const auto &reflected : static_active) {
    static_materialized.push_back(MaterializedOverride{
        .reflected = reflected,
        .default_evaluation = defaults.at(reflected.id),
        .selected = static_probe_values->at(reflected.id),
    });
  }

  auto verification_ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (verification_ir_result != tint::Success) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-IR", "verify",
                       verification_ir_result.Failure().reason));
    return 1;
  }
  auto &verification_ir = verification_ir_result.Get();
  std::map<uint16_t, tint::core::ir::Override *> verification_ir_overrides;
  internal_error = {};
  if (!CrossCheckIRSubset(verification_ir, inspected_all,
                          verification_ir_overrides, internal_error)) {
    WriteFailure(internal_error);
    return 1;
  }
  tint::core::ir::Builder verification_builder(verification_ir);
  for (const auto &[id, selection] : selections) {
    static_cast<void>(selection);
    const auto normalized = normalized_selections.find(id);
    if (normalized == normalized_selections.end()) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "verification is missing a normalized selection"));
      return 1;
    }
    auto *constant = MakeIRConstant(verification_builder, normalized->second);
    if (constant == nullptr) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "verification could not recreate a selection"));
      return 1;
    }
    verification_ir_overrides.at(id)->SetInitializer(constant);
  }
  auto single_entry = tint::core::ir::transform::SingleEntryPoint(
      verification_ir, arguments.entry_point);
  if (single_entry != tint::Success) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-SINGLE-ENTRY", "verify",
                       single_entry.Failure().reason));
    return 1;
  }
  internal_error = {};
  const auto retained_overrides =
      CollectIROverrides(verification_ir, internal_error);
  if (!internal_error.code.empty()) {
    WriteFailure(internal_error);
    return 1;
  }
  std::set<uint16_t> verification_relevant_selection_ids;
  for (const auto &[id, selection] : selections) {
    static_cast<void>(selection);
    if (!retained_overrides.contains(id)) {
      continue;
    }
    verification_relevant_selection_ids.insert(id);
  }
  if (verification_relevant_selection_ids != relevant_selection_ids) {
    WriteFailure(
        Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
              "materialization and verification config closures differ"));
    return 1;
  }
  std::set<uint16_t> retained_override_ids;
  for (const auto &[id, item] : retained_overrides) {
    static_cast<void>(item);
    retained_override_ids.insert(id);
  }
  if (retained_override_ids != effective_ir_ids) {
    WriteFailure(Error(
        "VGPU-C1-OVERRIDE-INTERNAL", "internal",
        "selected materialization and verification override sets differ"));
    return 1;
  }
  for (const auto &[id, retained] : retained_overrides) {
    const auto value = selected_values.find(id);
    const auto reflected = all_by_id.find(id);
    if (value == selected_values.end() || reflected == all_by_id.end() ||
        verification_ir.NameOf(retained).NameView() != reflected->second.name ||
        IRType(retained->Result()->Type()) != value->second.type) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "selected materialization and verification override "
                         "identity differ"));
      return 1;
    }
  }
  tint::SubstituteOverridesConfig substitution;
  for (const auto &[id, value] : selected_values) {
    substitution.map.emplace(tint::OverrideId{id},
                             TintSubstitutionValue(value));
  }
  auto substituted = tint::core::ir::transform::SubstituteOverrides(
      verification_ir, substitution);
  if (substituted != tint::Success) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-SUBSTITUTE", "verify",
                       substituted.Failure().reason));
    return 1;
  }
  for (const auto *instruction : verification_ir.Instructions()) {
    if (instruction->Is<tint::core::ir::Override>()) {
      WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "SubstituteOverrides left a live override"));
      return 1;
    }
  }

  tint::core::ir::Function *verified_entry = nullptr;
  for (auto *function : verification_ir.functions) {
    if (function->IsEntryPoint() &&
        verification_ir.NameOf(function).NameView() == arguments.entry_point) {
      if (verified_entry != nullptr) {
        WriteFailure(
            Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                  "SingleEntryPoint retained multiple selected entries"));
        return 1;
      }
      verified_entry = function;
    }
  }
  if (verified_entry == nullptr) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "SingleEntryPoint removed the selected entry"));
    return 1;
  }
  std::optional<std::array<WorkgroupAxisEvidence, 3>> workgroup_axes;
  if (verified_entry->IsCompute()) {
    const auto workgroup_size = verified_entry->WorkgroupSizeAsConst();
    if (!workgroup_size || !workgroup_dependency_names) {
      WriteFailure(
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "workgroup evidence is incomplete after substitution"));
      return 1;
    }
    workgroup_axes.emplace();
    for (size_t axis = 0; axis < workgroup_axes->size(); ++axis) {
      (*workgroup_axes)[axis].resolved = (*workgroup_size)[axis];
      (*workgroup_axes)[axis].override_dependencies =
          (*workgroup_dependency_names)[axis];
    }
  } else if (workgroup_dependency_names) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "non-compute entry produced workgroup evidence"));
    return 1;
  }

  WriteSuccess(arguments, entry.stage, *source_sha256, static_materialized,
               materialized, workgroup_axes);
  return 0;
}

} // namespace

int main(int argc, char **argv) { return Run(argc, argv); }
