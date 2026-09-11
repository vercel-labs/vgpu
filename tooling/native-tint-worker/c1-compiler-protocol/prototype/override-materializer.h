#ifndef VGPU_NATIVE_C1_COMPILER_PROTOCOL_OVERRIDE_MATERIALIZER_H_
#define VGPU_NATIVE_C1_COMPILER_PROTOCOL_OVERRIDE_MATERIALIZER_H_

#include <array>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace tint {
class Program;
namespace core::ir {
class Module;
}
} // namespace tint

namespace vgpu::native::overrides {

enum class ScalarType { kBool, kI32, kU32, kF16, kF32 };
enum class DefaultStatus { kAbsent, kUnavailable, kValue };
enum class PipelineStage { kVertex, kFragment, kCompute };
enum class DiagnosticCode {
  kNone,
  kRequest,
  kEntry,
  kUnknown,
  kDuplicateConfiguration,
  kWrongType,
  kNonFinite,
  kOutOfRange,
  kMissingRequired,
  kIr,
  kSingleEntry,
  kInvalidInitializer,
  kSubstitute,
  kInternal,
};
enum class DiagnosticPhase {
  kRequest,
  kInspect,
  kConfiguration,
  kMaterialize,
  kVerify,
  kInternal,
};

struct Diagnostic {
  DiagnosticCode code = DiagnosticCode::kNone;
  DiagnosticPhase phase = DiagnosticPhase::kInternal;
  std::string message;
};

struct F16Bits {
  uint16_t bits = 0;

  bool operator==(const F16Bits &) const = default;
};

struct F32Bits {
  uint32_t bits = 0;

  bool operator==(const F32Bits &) const = default;
};

using ScalarValue = std::variant<bool, int32_t, uint32_t, F16Bits, F32Bits>;

struct Configuration {
  std::string identifier;
  std::variant<bool, double> value;
};

struct DefaultResult {
  DefaultStatus status = DefaultStatus::kAbsent;
  std::optional<ScalarValue> value;

  bool operator==(const DefaultResult &) const = default;
};

struct OverrideRecord {
  std::string name;
  std::optional<uint16_t> wgsl_id;
  DefaultResult default_result;
  ScalarValue selected = false;

  bool operator==(const OverrideRecord &) const = default;
};

struct WorkgroupAxis {
  uint32_t resolved = 1;
  std::vector<std::string> override_dependencies;
};

struct SelectedEntry {
  std::string name;
  PipelineStage stage = PipelineStage::kVertex;
};

struct EntryResult {
  std::string name;
  PipelineStage stage = PipelineStage::kVertex;
  std::vector<std::string> exact_override_names;
  std::vector<std::string> effective_override_names;
  std::optional<std::array<WorkgroupAxis, 3>> workgroup_axes;
};

struct Materialization {
  std::vector<OverrideRecord> overrides;
  std::vector<EntryResult> entries;
};

using Result = std::variant<Materialization, Diagnostic>;

// Reflects, materializes, and independently verifies exact-static override
// values using Tint. The caller owns parsing, transport, hashing, and output.
Result Materialize(const tint::Program &program,
                   const std::vector<SelectedEntry> &selected_entries,
                   const std::vector<Configuration> &override_configuration);

// Installs already typed values into matching IR override declarations without
// passing through double. Input and IR size limits, invalid names, non-finite
// float bits, unknown names, duplicate IR names, and type drift fail closed
// before any initializer is changed.
std::optional<Diagnostic>
InstallValues(tint::core::ir::Module &module,
              const std::map<std::string, ScalarValue> &values);

const char *ScalarTypeName(ScalarType type);
ScalarType ScalarTypeOf(const ScalarValue &value);
const char *PipelineStageName(PipelineStage stage);
const char *DiagnosticCodeName(DiagnosticCode code);
const char *DiagnosticPhaseName(DiagnosticPhase phase);

} // namespace vgpu::native::overrides

#endif // VGPU_NATIVE_C1_COMPILER_PROTOCOL_OVERRIDE_MATERIALIZER_H_
