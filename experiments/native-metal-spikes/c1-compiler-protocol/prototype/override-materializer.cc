// Exact-static override materialization shared by the standalone feasibility
// adapter and the native Tint worker.

#include "override-materializer.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

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

namespace vgpu::native::overrides {

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

ScalarType ScalarTypeOf(const ScalarValue &value) {
  if (std::holds_alternative<bool>(value)) {
    return ScalarType::kBool;
  }
  if (std::holds_alternative<int32_t>(value)) {
    return ScalarType::kI32;
  }
  if (std::holds_alternative<uint32_t>(value)) {
    return ScalarType::kU32;
  }
  if (std::holds_alternative<F16Bits>(value)) {
    return ScalarType::kF16;
  }
  return ScalarType::kF32;
}

const char *PipelineStageName(PipelineStage stage) {
  switch (stage) {
  case PipelineStage::kVertex:
    return "vertex";
  case PipelineStage::kFragment:
    return "fragment";
  case PipelineStage::kCompute:
    return "compute";
  }
  return "unknown";
}

const char *DiagnosticCodeName(DiagnosticCode code) {
  switch (code) {
  case DiagnosticCode::kNone:
    return "VGPU-C1-OVERRIDE-INTERNAL";
  case DiagnosticCode::kRequest:
    return "VGPU-C1-OVERRIDE-REQUEST";
  case DiagnosticCode::kEntry:
    return "VGPU-C1-OVERRIDE-ENTRY";
  case DiagnosticCode::kUnknown:
    return "VGPU-C1-OVERRIDE-UNKNOWN";
  case DiagnosticCode::kDuplicateConfiguration:
    return "VGPU-C1-OVERRIDE-DUPLICATE-CONFIG";
  case DiagnosticCode::kWrongType:
    return "VGPU-C1-OVERRIDE-WRONG-TYPE";
  case DiagnosticCode::kNonFinite:
    return "VGPU-C1-OVERRIDE-NONFINITE";
  case DiagnosticCode::kOutOfRange:
    return "VGPU-C1-OVERRIDE-OUT-OF-RANGE";
  case DiagnosticCode::kMissingRequired:
    return "VGPU-C1-OVERRIDE-MISSING-REQUIRED";
  case DiagnosticCode::kIr:
    return "VGPU-C1-OVERRIDE-IR";
  case DiagnosticCode::kSingleEntry:
    return "VGPU-C1-OVERRIDE-SINGLE-ENTRY";
  case DiagnosticCode::kInvalidInitializer:
    return "VGPU-C1-OVERRIDE-INVALID-INITIALIZER";
  case DiagnosticCode::kSubstitute:
    return "VGPU-C1-OVERRIDE-SUBSTITUTE";
  case DiagnosticCode::kInternal:
    return "VGPU-C1-OVERRIDE-INTERNAL";
  }
  return "VGPU-C1-OVERRIDE-INTERNAL";
}

const char *DiagnosticPhaseName(DiagnosticPhase phase) {
  switch (phase) {
  case DiagnosticPhase::kRequest:
    return "request";
  case DiagnosticPhase::kInspect:
    return "inspect";
  case DiagnosticPhase::kConfiguration:
    return "config";
  case DiagnosticPhase::kMaterialize:
    return "materialize";
  case DiagnosticPhase::kVerify:
    return "verify";
  case DiagnosticPhase::kInternal:
    return "internal";
  }
  return "internal";
}

namespace {

constexpr size_t kMaxSelectedEntries = 2;
constexpr size_t kMaxConfigurationEntries = 4096;
constexpr size_t kMaxModuleOverrides = 4096;
constexpr size_t kMaxMemberships = 8192;
constexpr size_t kMaxIdentifierBytes = 256;
constexpr size_t kMaxDiagnosticBytes = 16 * 1024;

enum class InputKind { kBool, kNumber };
struct InputValue {
  InputKind kind = InputKind::kBool;
  bool boolean = false;
  double number = 0.0;
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

struct WorkgroupAxisEvidence {
  uint32_t resolved = 1;
  std::vector<std::string> override_dependencies;
};

struct ResolvedConfig {
  uint16_t id = 0;
  std::string identifier;
  InputValue input;
};

DiagnosticCode DiagnosticCodeFromName(std::string_view code) {
  for (const auto candidate : {
           DiagnosticCode::kRequest,
           DiagnosticCode::kEntry,
           DiagnosticCode::kUnknown,
           DiagnosticCode::kDuplicateConfiguration,
           DiagnosticCode::kWrongType,
           DiagnosticCode::kNonFinite,
           DiagnosticCode::kOutOfRange,
           DiagnosticCode::kMissingRequired,
           DiagnosticCode::kIr,
           DiagnosticCode::kSingleEntry,
           DiagnosticCode::kInvalidInitializer,
           DiagnosticCode::kSubstitute,
           DiagnosticCode::kInternal,
       }) {
    if (code == DiagnosticCodeName(candidate)) {
      return candidate;
    }
  }
  return DiagnosticCode::kInternal;
}

DiagnosticPhase DiagnosticPhaseFromName(std::string_view phase) {
  for (const auto candidate : {
           DiagnosticPhase::kRequest,
           DiagnosticPhase::kInspect,
           DiagnosticPhase::kConfiguration,
           DiagnosticPhase::kMaterialize,
           DiagnosticPhase::kVerify,
           DiagnosticPhase::kInternal,
       }) {
    if (phase == DiagnosticPhaseName(candidate)) {
      return candidate;
    }
  }
  return DiagnosticPhase::kInternal;
}

Diagnostic Error(std::string_view code, std::string_view phase,
                 std::string message) {
  if (message.size() > kMaxDiagnosticBytes) {
    size_t end = kMaxDiagnosticBytes;
    while (end > 0 &&
           (static_cast<unsigned char>(message[end]) & 0xc0u) == 0x80u) {
      --end;
    }
    message.resize(end);
  }
  return Diagnostic{.code = DiagnosticCodeFromName(code),
                    .phase = DiagnosticPhaseFromName(phase),
                    .message = std::move(message)};
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
  if (diagnostic.code != DiagnosticCode::kNone) {
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

std::set<uint16_t> OverrideDependencies(const tint::core::ir::Value *value) {
  std::set<const tint::core::ir::Value *> visited;
  std::set<uint16_t> dependencies;
  std::vector<const tint::core::ir::Value *> pending{value};
  while (!pending.empty()) {
    const auto *current = pending.back();
    pending.pop_back();
    if (current == nullptr || !visited.insert(current).second) {
      continue;
    }
    const auto *result = current->As<tint::core::ir::InstructionResult>();
    if (result == nullptr || result->Instruction() == nullptr) {
      continue;
    }
    const auto *instruction = result->Instruction();
    if (const auto *item = instruction->As<tint::core::ir::Override>()) {
      if (item->OverrideId()) {
        dependencies.insert(item->OverrideId()->value);
      }
    }
    for (const auto *operand : instruction->Operands()) {
      pending.push_back(operand);
    }
    if (const auto *control =
            instruction->As<tint::core::ir::ControlInstruction>()) {
      control->ForeachBlock([&](const tint::core::ir::Block *block) {
        for (const auto *nested : *block) {
          for (const auto *operand : nested->Operands()) {
            pending.push_back(operand);
          }
        }
      });
    }
  }
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

std::optional<PipelineStage>
MaterializerStage(tint::inspector::PipelineStage stage) {
  switch (stage) {
  case tint::inspector::PipelineStage::kVertex:
    return PipelineStage::kVertex;
  case tint::inspector::PipelineStage::kFragment:
    return PipelineStage::kFragment;
  case tint::inspector::PipelineStage::kCompute:
    return PipelineStage::kCompute;
  }
  return std::nullopt;
}

struct EntryPlan {
  std::string name;
  PipelineStage stage = PipelineStage::kVertex;
  std::map<uint16_t, ReflectedOverride> static_by_id;
  std::vector<ReflectedOverride> static_overrides;
};

struct Plan {
  std::map<uint16_t, ReflectedOverride> declarations_by_id;
  std::map<std::string, uint16_t> selector_to_id;
  std::vector<ReflectedOverride> declarations;
  std::map<uint16_t, ReflectedOverride> static_union_by_id;
  std::vector<ReflectedOverride> static_union;
  std::vector<EntryPlan> entries;
};

using InputById = std::map<uint16_t, InputValue>;
using TypedById = std::map<uint16_t, TypedValue>;
using DefaultsById = std::map<uint16_t, DefaultEvaluation>;

struct EntryEvidence {
  std::vector<std::string> effective_names;
  std::optional<std::array<WorkgroupAxisEvidence, 3>> workgroup_axes;
};

bool BuildPlan(const tint::Program &program,
               const std::vector<SelectedEntry> &selected_entries, Plan &plan,
               Diagnostic &diagnostic) {
  tint::inspector::Inspector inspector(program);
  const auto inspected_overrides = inspector.Overrides();
  if (inspector.has_error()) {
    diagnostic =
        Error("VGPU-C1-OVERRIDE-INTERNAL", "inspect", inspector.error());
    return false;
  }
  if (inspected_overrides.size() > kMaxModuleOverrides) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "module override count exceeds the materializer limit");
    return false;
  }

  for (const auto &inspected : inspected_overrides) {
    if (inspected.name.empty() || inspected.name.size() > kMaxIdentifierBytes) {
      diagnostic =
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "reflected override name exceeds the materializer limit");
      return false;
    }
    const auto type = InspectorType(inspected.type);
    if (!type) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "Inspector returned an unsupported override type");
      return false;
    }
    ReflectedOverride reflected{
        .name = inspected.name,
        .id = inspected.id.value,
        .type = *type,
        .has_initializer = inspected.is_initialized,
        .explicit_id = inspected.is_id_specified,
    };
    const std::string selector =
        reflected.explicit_id ? std::to_string(reflected.id) : reflected.name;
    if (!plan.declarations_by_id.emplace(reflected.id, reflected).second ||
        !plan.selector_to_id.emplace(selector, reflected.id).second) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "Inspector returned duplicate override identity");
      return false;
    }
  }
  for (const auto &[id, declaration] : plan.declarations_by_id) {
    static_cast<void>(id);
    plan.declarations.push_back(declaration);
  }

  plan.entries.reserve(selected_entries.size());
  for (const auto &selected : selected_entries) {
    const auto inspected_entry = inspector.GetEntryPoint(selected.name);
    if (inspector.has_error()) {
      diagnostic =
          Error("VGPU-C1-OVERRIDE-ENTRY", "inspect", inspector.error());
      return false;
    }
    const auto reflected_stage = MaterializerStage(inspected_entry.stage);
    if (!reflected_stage) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "Inspector returned an unsupported pipeline stage");
      return false;
    }
    if (*reflected_stage != selected.stage) {
      diagnostic = Error("VGPU-C1-OVERRIDE-ENTRY", "inspect",
                         "selected entry stage disagrees with Tint reflection");
      return false;
    }
    if (inspected_entry.overrides.size() > kMaxModuleOverrides) {
      diagnostic =
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "entry override membership exceeds the materializer limit");
      return false;
    }

    EntryPlan entry{.name = selected.name, .stage = *reflected_stage};
    for (const auto &inspected : inspected_entry.overrides) {
      const auto declaration = plan.declarations_by_id.find(inspected.id.value);
      if (declaration == plan.declarations_by_id.end() ||
          !entry.static_by_id.emplace(declaration->first, declaration->second)
               .second) {
        diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                           "entry reflection disagrees with module overrides");
        return false;
      }
      plan.static_union_by_id.emplace(declaration->first, declaration->second);
    }
    for (const auto &[id, declaration] : entry.static_by_id) {
      static_cast<void>(id);
      entry.static_overrides.push_back(declaration);
    }
    std::sort(entry.static_overrides.begin(), entry.static_overrides.end(),
              [](const auto &left, const auto &right) {
                return left.name < right.name;
              });
    plan.entries.push_back(std::move(entry));
  }

  for (const auto &[id, declaration] : plan.static_union_by_id) {
    static_cast<void>(id);
    plan.static_union.push_back(declaration);
  }
  std::sort(plan.static_union.begin(), plan.static_union.end(),
            [](const auto &left, const auto &right) {
              return left.name < right.name;
            });
  return true;
}

bool ResolveConfiguration(const Plan &plan,
                          const std::vector<Configuration> &configuration,
                          InputById &inputs, Diagnostic &diagnostic) {
  std::vector<ResolvedConfig> resolved;
  std::vector<std::pair<std::string, Diagnostic>> errors;
  for (const auto &item : configuration) {
    const auto declaration = plan.selector_to_id.find(item.identifier);
    if (declaration == plan.selector_to_id.end()) {
      errors.emplace_back(item.identifier,
                          Error("VGPU-C1-OVERRIDE-UNKNOWN", "config",
                                "override config key " + item.identifier +
                                    " matches no declaration"));
      continue;
    }
    InputValue input;
    if (const auto *boolean = std::get_if<bool>(&item.value)) {
      input = InputValue{.kind = InputKind::kBool, .boolean = *boolean};
    } else {
      input = InputValue{.kind = InputKind::kNumber,
                         .number = std::get<double>(item.value)};
    }
    resolved.push_back(ResolvedConfig{.id = declaration->second,
                                      .identifier = item.identifier,
                                      .input = input});
  }
  if (!errors.empty()) {
    std::sort(errors.begin(), errors.end(),
              [](const auto &left, const auto &right) {
                return left.first < right.first;
              });
    diagnostic = std::move(errors.front().second);
    return false;
  }
  std::sort(resolved.begin(), resolved.end(),
            [](const auto &left, const auto &right) {
              if (left.id != right.id) {
                return left.id < right.id;
              }
              return left.identifier < right.identifier;
            });
  for (size_t index = 0; index < resolved.size();) {
    size_t end = index + 1;
    while (end < resolved.size() && resolved[end].id == resolved[index].id) {
      ++end;
    }
    const auto &item = resolved[index];
    const auto &declaration = plan.declarations_by_id.at(item.id);
    if (end - index > 1) {
      diagnostic =
          Error("VGPU-C1-OVERRIDE-DUPLICATE-CONFIG", "config",
                "override " + declaration.name + " appears more than once");
      return false;
    }
    if (!ValidateInput(item.input, declaration, diagnostic)) {
      return false;
    }
    inputs.emplace(item.id, item.input);
    index = end;
  }
  return true;
}

bool NormalizeConfiguration(const tint::Program &program, const Plan &plan,
                            const InputById &inputs, TypedById &typed,
                            Diagnostic &diagnostic) {
  auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (ir_result != tint::Success) {
    diagnostic =
        Error("VGPU-C1-OVERRIDE-IR", "materialize", ir_result.Failure().reason);
    return false;
  }
  auto &ir = ir_result.Get();
  std::map<uint16_t, tint::core::ir::Override *> ir_overrides;
  if (!CrossCheckIRSubset(ir, plan.declarations, ir_overrides, diagnostic) ||
      ir_overrides.size() != plan.declarations_by_id.size()) {
    if (diagnostic.code == DiagnosticCode::kNone) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "normalization IR omitted an Inspector override");
    }
    return false;
  }
  tint::core::ir::Builder builder(ir);
  for (const auto &[id, input] : inputs) {
    auto normalized =
        ConvertInputWithTint(ir, *ir_overrides.at(id), input, diagnostic);
    if (!normalized ||
        normalized->type != plan.declarations_by_id.at(id).type) {
      if (diagnostic.code == DiagnosticCode::kNone) {
        diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                           "Tint conversion returned the wrong scalar type");
      }
      return false;
    }
    auto *constant = MakeIRConstant(builder, *normalized);
    const auto canonical =
        constant == nullptr ? std::nullopt : TypedConstant(constant->Value());
    if (!canonical || canonical->type != normalized->type) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "Tint selection constant has the wrong scalar type");
      return false;
    }
    typed.emplace(id, *canonical);
  }
  return true;
}

ScalarValue PublicValue(const TypedValue &value) {
  switch (value.type) {
  case ScalarType::kBool:
    return value.boolean;
  case ScalarType::kI32:
    return value.i32;
  case ScalarType::kU32:
    return value.u32;
  case ScalarType::kF16:
    return F16Bits{.bits = value.f16_bits};
  case ScalarType::kF32:
    return F32Bits{.bits = value.f32_bits};
  }
  return false;
}

TypedValue InternalValue(const ScalarValue &value) {
  if (const auto *boolean = std::get_if<bool>(&value)) {
    return TypedValue{.type = ScalarType::kBool, .boolean = *boolean};
  }
  if (const auto *i32 = std::get_if<int32_t>(&value)) {
    return TypedValue{.type = ScalarType::kI32, .i32 = *i32};
  }
  if (const auto *u32 = std::get_if<uint32_t>(&value)) {
    return TypedValue{.type = ScalarType::kU32, .u32 = *u32};
  }
  if (const auto *f16 = std::get_if<F16Bits>(&value)) {
    return TypedValue{.type = ScalarType::kF16, .f16_bits = f16->bits};
  }
  return TypedValue{.type = ScalarType::kF32,
                    .f32_bits = std::get<F32Bits>(value).bits};
}

std::map<std::string, ScalarValue> NamedValues(const Plan &plan,
                                               const TypedById &values) {
  std::map<std::string, ScalarValue> named;
  for (const auto &[id, value] : values) {
    named.emplace(plan.declarations_by_id.at(id).name, PublicValue(value));
  }
  return named;
}

bool InstallById(tint::core::ir::Module &ir, const Plan &plan,
                 const TypedById &values, Diagnostic &diagnostic) {
  if (const auto error = InstallValues(ir, NamedValues(plan, values))) {
    diagnostic = *error;
    return false;
  }
  return true;
}

bool MaterializeStaticUnion(const tint::Program &program, const Plan &plan,
                            const TypedById &configured, TypedById &selected,
                            Diagnostic &diagnostic) {
  auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (ir_result != tint::Success) {
    diagnostic =
        Error("VGPU-C1-OVERRIDE-IR", "materialize", ir_result.Failure().reason);
    return false;
  }
  auto &ir = ir_result.Get();
  std::map<uint16_t, tint::core::ir::Override *> ir_overrides;
  if (!CrossCheckIRSubset(ir, plan.declarations, ir_overrides, diagnostic) ||
      ir_overrides.size() != plan.declarations_by_id.size()) {
    if (diagnostic.code == DiagnosticCode::kNone) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "static IR omitted an Inspector override");
    }
    return false;
  }
  if (!InstallById(ir, plan, configured, diagnostic)) {
    return false;
  }

  tint::core::ir::ReferencedModuleDecls<tint::core::ir::Module> referenced(ir);
  tint::core::ir::ReferencedModuleDecls<tint::core::ir::Module>::DeclSet
      closure;
  for (const auto &[id, declaration] : plan.static_union_by_id) {
    static_cast<void>(declaration);
    auto *target = ir_overrides.at(id);
    referenced.AddToBlock(closure, target);
    if (!closure.Contains(target)) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "static union closure omitted its root");
      return false;
    }
  }

  std::vector<tint::core::ir::Function *> functions;
  for (auto *function : ir.functions) {
    functions.push_back(function);
  }
  for (auto *function : functions) {
    ir.Destroy(function);
  }
  std::vector<tint::core::ir::Instruction *> instructions;
  for (auto *instruction : *ir.root_block) {
    instructions.push_back(instruction);
  }
  for (auto instruction = instructions.rbegin();
       instruction != instructions.rend(); ++instruction) {
    if (!closure.Contains(*instruction)) {
      (*instruction)->Destroy();
    }
  }

  diagnostic = {};
  const auto retained = CollectIROverrides(ir, diagnostic);
  if (diagnostic.code != DiagnosticCode::kNone) {
    return false;
  }
  std::set<uint16_t> expected_ids;
  for (const auto &[id, declaration] : plan.static_union_by_id) {
    static_cast<void>(declaration);
    expected_ids.insert(id);
  }
  std::set<uint16_t> retained_ids;
  for (const auto &[id, item] : retained) {
    const auto declaration = plan.static_union_by_id.find(id);
    if (declaration == plan.static_union_by_id.end() ||
        ir.NameOf(item).NameView() != declaration->second.name ||
        IRType(item->Result()->Type()) != declaration->second.type) {
      diagnostic =
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "static union closure disagrees with Inspector reflection");
      return false;
    }
    retained_ids.insert(id);
  }
  if (retained_ids != expected_ids) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "static declaration closure is not the exact union");
    return false;
  }

  const auto probes = AddOverrideProbes(ir, retained, diagnostic);
  if (diagnostic.code != DiagnosticCode::kNone) {
    return false;
  }
  tint::SubstituteOverridesConfig substitution;
  if (tint::core::ir::transform::SubstituteOverrides(ir, substitution) !=
      tint::Success) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INVALID-INITIALIZER", "materialize",
                       "Tint could not materialize the static override union");
    return false;
  }
  auto values = ReadOverrideProbes(probes, diagnostic);
  if (!values || values->size() != expected_ids.size()) {
    if (diagnostic.code == DiagnosticCode::kNone) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "static union probes produced an incomplete map");
    }
    return false;
  }
  for (const auto &declaration : plan.static_union) {
    const auto value = values->find(declaration.id);
    if (value == values->end() || value->second.type != declaration.type) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "static union probe has the wrong identity");
      return false;
    }
    const auto configured_value = configured.find(declaration.id);
    if (configured_value != configured.end() &&
        !SameTypedValue(configured_value->second, value->second)) {
      diagnostic =
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "static union probe disagrees with Tint input conversion");
      return false;
    }
  }
  selected = std::move(*values);
  return true;
}

bool EvaluateDefaults(const tint::Program &program, const Plan &plan,
                      DefaultsById &defaults, Diagnostic &diagnostic) {
  for (const auto &declaration : plan.static_union) {
    if (!declaration.has_initializer) {
      defaults.emplace(declaration.id,
                       DefaultEvaluation{.status = DefaultStatus::kAbsent});
      continue;
    }
    auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
    if (ir_result != tint::Success) {
      diagnostic = Error("VGPU-C1-OVERRIDE-IR", "materialize",
                         ir_result.Failure().reason);
      return false;
    }
    auto &ir = ir_result.Get();
    std::map<uint16_t, tint::core::ir::Override *> ir_overrides;
    if (!CrossCheckIRSubset(ir, plan.declarations, ir_overrides, diagnostic) ||
        ir_overrides.size() != plan.declarations_by_id.size()) {
      if (diagnostic.code == DiagnosticCode::kNone) {
        diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                           "default IR omitted an Inspector override");
      }
      return false;
    }
    const auto target = ir_overrides.find(declaration.id);
    if (target == ir_overrides.end() ||
        target->second->Initializer() == nullptr) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "default pass lost a reflected initializer");
      return false;
    }
    tint::core::ir::ReferencedModuleDecls<tint::core::ir::Module> referenced(
        ir);
    tint::core::ir::ReferencedModuleDecls<tint::core::ir::Module>::DeclSet
        closure;
    referenced.AddToBlock(closure, target->second);
    if (!closure.Contains(target->second)) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "default closure omitted its target override");
      return false;
    }
    std::vector<tint::core::ir::Function *> functions;
    for (auto *function : ir.functions) {
      functions.push_back(function);
    }
    for (auto *function : functions) {
      ir.Destroy(function);
    }
    std::vector<tint::core::ir::Instruction *> instructions;
    for (auto *instruction : *ir.root_block) {
      instructions.push_back(instruction);
    }
    for (auto instruction = instructions.rbegin();
         instruction != instructions.rend(); ++instruction) {
      if (!closure.Contains(*instruction)) {
        (*instruction)->Destroy();
      }
    }
    std::map<uint16_t, tint::core::ir::Override *> target_override{
        {declaration.id, target->second}};
    const auto probes = AddOverrideProbes(ir, target_override, diagnostic);
    if (diagnostic.code != DiagnosticCode::kNone) {
      return false;
    }
    tint::SubstituteOverridesConfig substitution;
    if (tint::core::ir::transform::SubstituteOverrides(ir, substitution) !=
        tint::Success) {
      defaults.emplace(
          declaration.id,
          DefaultEvaluation{.status = DefaultStatus::kUnavailable});
      continue;
    }
    auto values = ReadOverrideProbes(probes, diagnostic);
    if (!values) {
      return false;
    }
    const auto value = values->find(declaration.id);
    if (value == values->end() || value->second.type != declaration.type) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "default probe returned the wrong scalar type");
      return false;
    }
    defaults.emplace(declaration.id,
                     DefaultEvaluation{.status = DefaultStatus::kValue,
                                       .value = value->second});
  }
  return true;
}

bool MaterializeEntryEvidence(const tint::Program &program, const Plan &plan,
                              const EntryPlan &entry,
                              const TypedById &configured,
                              const TypedById &static_values,
                              EntryEvidence &evidence, Diagnostic &diagnostic) {
  auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (ir_result != tint::Success) {
    diagnostic =
        Error("VGPU-C1-OVERRIDE-IR", "materialize", ir_result.Failure().reason);
    return false;
  }
  auto &ir = ir_result.Get();
  std::map<uint16_t, tint::core::ir::Override *> ir_overrides;
  if (!CrossCheckIRSubset(ir, plan.declarations, ir_overrides, diagnostic) ||
      ir_overrides.size() != plan.declarations_by_id.size() ||
      !InstallById(ir, plan, configured, diagnostic)) {
    return false;
  }
  if (tint::core::ir::transform::SingleEntryPoint(ir, entry.name) !=
      tint::Success) {
    diagnostic = Error("VGPU-C1-OVERRIDE-SINGLE-ENTRY", "materialize",
                       "Tint could not select the requested entry point");
    return false;
  }

  diagnostic = {};
  const auto effective = CollectIROverrides(ir, diagnostic);
  if (diagnostic.code != DiagnosticCode::kNone) {
    return false;
  }
  std::set<uint16_t> effective_ids;
  for (const auto &[id, item] : effective) {
    const auto declaration = entry.static_by_id.find(id);
    if (declaration == entry.static_by_id.end() ||
        ir.NameOf(item).NameView() != declaration->second.name ||
        IRType(item->Result()->Type()) != declaration->second.type) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "selected entry produced an unknown override");
      return false;
    }
    effective_ids.insert(id);
  }

  std::optional<std::array<std::vector<std::string>, 3>> dependency_names;
  auto *selected_entry = FindEntryFunction(ir, entry.name);
  if (selected_entry == nullptr) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "Tint IR did not contain exactly one selected entry");
    return false;
  }
  if (selected_entry->IsCompute()) {
    const auto workgroup_size = selected_entry->WorkgroupSize();
    if (!workgroup_size) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "compute entry has no selected workgroup size");
      return false;
    }
    dependency_names.emplace();
    for (size_t axis = 0; axis < workgroup_size->size(); ++axis) {
      for (const auto dependency :
           OverrideDependencies((*workgroup_size)[axis])) {
        if (!effective_ids.contains(dependency)) {
          diagnostic =
              Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                    "workgroup expression references an inactive override");
          return false;
        }
        (*dependency_names)[axis].push_back(
            plan.declarations_by_id.at(dependency).name);
      }
      std::sort((*dependency_names)[axis].begin(),
                (*dependency_names)[axis].end());
    }
  }

  const auto probes = AddOverrideProbes(ir, effective, diagnostic);
  if (diagnostic.code != DiagnosticCode::kNone) {
    return false;
  }
  tint::SubstituteOverridesConfig substitution;
  if (tint::core::ir::transform::SubstituteOverrides(ir, substitution) !=
      tint::Success) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INVALID-INITIALIZER", "materialize",
                       "Tint could not materialize the selected overrides");
    return false;
  }
  auto probe_values = ReadOverrideProbes(probes, diagnostic);
  if (!probe_values) {
    return false;
  }
  TypedById selected_values;
  for (const auto &[id, value] : configured) {
    if (effective_ids.contains(id)) {
      selected_values.emplace(id, value);
    }
  }
  for (const auto &[id, value] : *probe_values) {
    const auto [found, inserted] = selected_values.emplace(id, value);
    if (!inserted && !SameTypedValue(found->second, value)) {
      diagnostic = Error(
          "VGPU-C1-OVERRIDE-INTERNAL", "internal",
          "configured override probe disagrees with its normalized value");
      return false;
    }
  }
  if (selected_values.size() != effective_ids.size()) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "selected override probes produced an incomplete map");
    return false;
  }
  for (const auto &[id, value] : selected_values) {
    const auto union_value = static_values.find(id);
    if (union_value == static_values.end() ||
        !SameTypedValue(value, union_value->second)) {
      diagnostic =
          Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                "entry evidence disagrees with the exact-static union");
      return false;
    }
  }

  auto verification_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (verification_result != tint::Success) {
    diagnostic = Error("VGPU-C1-OVERRIDE-IR", "verify",
                       verification_result.Failure().reason);
    return false;
  }
  auto &verification = verification_result.Get();
  std::map<uint16_t, tint::core::ir::Override *> verification_overrides;
  if (!CrossCheckIRSubset(verification, plan.declarations,
                          verification_overrides, diagnostic) ||
      verification_overrides.size() != plan.declarations_by_id.size() ||
      !InstallById(verification, plan, configured, diagnostic)) {
    if (diagnostic.code == DiagnosticCode::kNone) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "verification IR omitted an Inspector override");
    }
    return false;
  }
  if (tint::core::ir::transform::SingleEntryPoint(verification, entry.name) !=
      tint::Success) {
    diagnostic = Error("VGPU-C1-OVERRIDE-SINGLE-ENTRY", "verify",
                       "Tint could not verify the requested entry point");
    return false;
  }
  diagnostic = {};
  const auto retained = CollectIROverrides(verification, diagnostic);
  if (diagnostic.code != DiagnosticCode::kNone) {
    return false;
  }
  std::set<uint16_t> retained_ids;
  for (const auto &[id, item] : retained) {
    static_cast<void>(item);
    retained_ids.insert(id);
  }
  if (retained_ids != effective_ids) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "materialization and verification override sets differ");
    return false;
  }
  if (!InstallById(verification, plan, selected_values, diagnostic)) {
    return false;
  }
  tint::SubstituteOverridesConfig verification_substitution;
  if (tint::core::ir::transform::SubstituteOverrides(
          verification, verification_substitution) != tint::Success) {
    diagnostic = Error("VGPU-C1-OVERRIDE-SUBSTITUTE", "verify",
                       "Tint rejected the exact selected override map");
    return false;
  }
  for (const auto *instruction : verification.Instructions()) {
    if (instruction->Is<tint::core::ir::Override>()) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "SubstituteOverrides left a live override");
      return false;
    }
  }

  auto *verified_entry = FindEntryFunction(verification, entry.name);
  if (verified_entry == nullptr) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "verification lost the selected entry point");
    return false;
  }
  if (verified_entry->IsCompute()) {
    const auto workgroup_size = verified_entry->WorkgroupSizeAsConst();
    if (!workgroup_size || !dependency_names) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "workgroup evidence is incomplete after substitution");
      return false;
    }
    if ((*workgroup_size)[0] == 0 || (*workgroup_size)[1] == 0 ||
        (*workgroup_size)[2] == 0) {
      diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                         "workgroup dimensions must be positive");
      return false;
    }
    evidence.workgroup_axes.emplace();
    for (size_t axis = 0; axis < evidence.workgroup_axes->size(); ++axis) {
      (*evidence.workgroup_axes)[axis].resolved = (*workgroup_size)[axis];
      (*evidence.workgroup_axes)[axis].override_dependencies =
          (*dependency_names)[axis];
    }
  } else if (dependency_names) {
    diagnostic = Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "non-compute entry produced workgroup evidence");
    return false;
  }

  for (const auto id : effective_ids) {
    evidence.effective_names.push_back(plan.declarations_by_id.at(id).name);
  }
  std::sort(evidence.effective_names.begin(), evidence.effective_names.end());
  return true;
}

OverrideRecord PublicRecord(const ReflectedOverride &declaration,
                            const DefaultEvaluation &default_evaluation,
                            const TypedValue &selected) {
  DefaultResult default_result{.status = default_evaluation.status};
  if (default_evaluation.value) {
    default_result.value = PublicValue(*default_evaluation.value);
  }
  return OverrideRecord{
      .name = declaration.name,
      .wgsl_id = declaration.explicit_id
                     ? std::optional<uint16_t>{declaration.id}
                     : std::nullopt,
      .default_result = std::move(default_result),
      .selected = PublicValue(selected),
  };
}

} // namespace

std::optional<Diagnostic>
InstallValues(tint::core::ir::Module &module,
              const std::map<std::string, ScalarValue> &values) {
  if (values.size() > kMaxConfigurationEntries) {
    return Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                 "typed override values exceed the installer limit");
  }
  for (const auto &[name, value] : values) {
    if (name.empty() || name.size() > kMaxIdentifierBytes) {
      return Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                   "typed override names must contain 1 to 256 bytes");
    }
    if (const auto *f16 = std::get_if<F16Bits>(&value);
        f16 != nullptr && (f16->bits & 0x7c00u) == 0x7c00u) {
      return Error("VGPU-C1-OVERRIDE-NONFINITE", "config",
                   "typed f16 override bits must be finite");
    }
    if (const auto *f32 = std::get_if<F32Bits>(&value);
        f32 != nullptr && (f32->bits & 0x7f800000u) == 0x7f800000u) {
      return Error("VGPU-C1-OVERRIDE-NONFINITE", "config",
                   "typed f32 override bits must be finite");
    }
  }
  std::map<std::string, tint::core::ir::Override *> by_name;
  if (module.root_block == nullptr) {
    return Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                 "Tint IR has no root block for override installation");
  }
  for (auto *instruction : *module.root_block) {
    auto *item = instruction->As<tint::core::ir::Override>();
    if (item == nullptr) {
      continue;
    }
    const std::string name(module.NameOf(item).NameView());
    if (name.empty() || name.size() > kMaxIdentifierBytes ||
        !by_name.emplace(name, item).second) {
      return Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                   "Tint IR has an invalid or duplicate override name");
    }
    if (by_name.size() > kMaxModuleOverrides) {
      return Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                   "Tint IR override count exceeds the installer limit");
    }
  }

  tint::core::ir::Builder builder(module);
  for (const auto &[name, value] : values) {
    const auto found = by_name.find(name);
    if (found == by_name.end()) {
      return Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                   "typed override value matches no IR declaration");
    }
    if (IRType(found->second->Result()->Type()) != ScalarTypeOf(value)) {
      return Error("VGPU-C1-OVERRIDE-WRONG-TYPE", "config",
                   "typed override value disagrees with its IR declaration");
    }
  }
  for (const auto &[name, value] : values) {
    auto *item = by_name.at(name);
    auto *constant = MakeIRConstant(builder, InternalValue(value));
    if (constant == nullptr) {
      return Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                   "could not recreate a typed override value");
    }
    item->SetInitializer(constant);
  }
  return std::nullopt;
}

Result Materialize(const tint::Program &program,
                   const std::vector<SelectedEntry> &selected_entries,
                   const std::vector<Configuration> &override_configuration) {
  if (selected_entries.empty() ||
      selected_entries.size() > kMaxSelectedEntries) {
    return Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                 "selected entry point count must be between one and two");
  }
  if (override_configuration.size() > kMaxConfigurationEntries) {
    return Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                 "override configuration exceeds the materializer limit");
  }
  std::set<std::string> unique_entries;
  for (const auto &entry : selected_entries) {
    if (entry.name.empty() || entry.name.size() > kMaxIdentifierBytes ||
        !unique_entries.insert(entry.name).second) {
      return Error(
          "VGPU-C1-OVERRIDE-REQUEST", "request",
          "selected entry points must be unique names of at most 256 bytes");
    }
  }
  for (const auto &configuration : override_configuration) {
    if (configuration.identifier.empty() ||
        configuration.identifier.size() > kMaxIdentifierBytes) {
      return Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                   "override identifiers must contain 1 to 256 bytes");
    }
  }

  Diagnostic diagnostic;
  Plan plan;
  if (!BuildPlan(program, selected_entries, plan, diagnostic)) {
    return diagnostic;
  }
  InputById inputs;
  if (!ResolveConfiguration(plan, override_configuration, inputs, diagnostic)) {
    return diagnostic;
  }
  for (const auto &[id, declaration] : plan.static_union_by_id) {
    if (!declaration.has_initializer && !inputs.contains(id)) {
      return Error("VGPU-C1-OVERRIDE-MISSING-REQUIRED", "materialize",
                   "active override " + declaration.name +
                       " has no initializer and must be configured");
    }
  }

  TypedById configured;
  if (!NormalizeConfiguration(program, plan, inputs, configured, diagnostic)) {
    return diagnostic;
  }
  TypedById static_values;
  if (!MaterializeStaticUnion(program, plan, configured, static_values,
                              diagnostic)) {
    return diagnostic;
  }
  DefaultsById defaults;
  if (!EvaluateDefaults(program, plan, defaults, diagnostic)) {
    return diagnostic;
  }

  Materialization output;
  output.overrides.reserve(plan.static_union.size());
  for (const auto &declaration : plan.static_union) {
    auto record = PublicRecord(declaration, defaults.at(declaration.id),
                               static_values.at(declaration.id));
    if ((record.default_result.status == DefaultStatus::kValue) !=
            record.default_result.value.has_value() ||
        ScalarTypeOf(record.selected) != declaration.type ||
        (record.default_result.value &&
         ScalarTypeOf(*record.default_result.value) != declaration.type)) {
      return Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                   "public override value has the wrong scalar type");
    }
    output.overrides.push_back(std::move(record));
  }

  size_t membership_count = 0;
  output.entries.reserve(plan.entries.size());
  for (const auto &planned_entry : plan.entries) {
    EntryEvidence evidence;
    if (!MaterializeEntryEvidence(program, plan, planned_entry, configured,
                                  static_values, evidence, diagnostic)) {
      return diagnostic;
    }
    EntryResult entry{
        .name = planned_entry.name,
        .stage = planned_entry.stage,
        .workgroup_axes = std::nullopt,
    };
    for (const auto &declaration : planned_entry.static_overrides) {
      entry.exact_override_names.push_back(declaration.name);
    }
    entry.effective_override_names = std::move(evidence.effective_names);
    if (evidence.workgroup_axes) {
      entry.workgroup_axes.emplace();
      for (size_t axis = 0; axis < entry.workgroup_axes->size(); ++axis) {
        (*entry.workgroup_axes)[axis] = WorkgroupAxis{
            .resolved = (*evidence.workgroup_axes)[axis].resolved,
            .override_dependencies =
                (*evidence.workgroup_axes)[axis].override_dependencies,
        };
      }
    }
    membership_count += entry.exact_override_names.size();
    membership_count += entry.effective_override_names.size();
    if (membership_count > kMaxMemberships) {
      return Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                   "override memberships exceed the materializer limit");
    }
    output.entries.push_back(std::move(entry));
  }
  if (output.overrides.size() > kMaxModuleOverrides) {
    return Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                 "program override union exceeds the materializer limit");
  }
  return output;
}

} // namespace vgpu::native::overrides
