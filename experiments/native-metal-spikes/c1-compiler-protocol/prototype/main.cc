// Feasibility prototype for the vgpu-owned Tint tool protocol.
//
// This one-shot worker reads exactly one UTF-8 JSON request from stdin through
// EOF and writes exactly one JSON response to stdout. A decoded request always
// exits zero, including protocol and compiler failures; framing, I/O, or a
// process failure exits nonzero and makes stdout untrustworthy.
//
// The inventory operation reports only canonical WGSL entry names and stages.
// The semantic-extraction operation reports program-scoped compiler facts; its
// current executable profile accepts singular resources, including
// runtime-sized storage-buffer layouts.
// The translation operation owns the Metal ABI instead of accepting
// translator-selected internals. External buffer intervals are restricted to
// 0..<30. Tint receives one shared immediate-data binding at buffer(30), with
// the storage-buffer-size table starting at byte offset 4 and the ordinary
// non-constant-zero word at byte offset 0. The translation response reports an
// effective internal binding and storage-buffer-size region only when Tint's
// raised entry interface / writer output uses them.

#include <algorithm>
#include <cstdint>
#include <exception>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include "src/tint/api/common/bindings.h"
#include "src/tint/api/tint.h"
#include "src/tint/lang/core/ir/override.h"
#include "src/tint/lang/core/ir/referenced_module_vars.h"
#include "src/tint/lang/core/ir/transform/single_entry_point.h"
#include "src/tint/lang/core/ir/transform/substitute_overrides.h"
#include "src/tint/lang/core/ir/var.h"
#include "src/tint/lang/core/type/array.h"
#include "src/tint/lang/core/type/atomic.h"
#include "src/tint/lang/core/type/binding_array.h"
#include "src/tint/lang/core/type/bool.h"
#include "src/tint/lang/core/type/f16.h"
#include "src/tint/lang/core/type/f32.h"
#include "src/tint/lang/core/type/i32.h"
#include "src/tint/lang/core/type/matrix.h"
#include "src/tint/lang/core/type/memory_view.h"
#include "src/tint/lang/core/type/pointer.h"
#include "src/tint/lang/core/type/sampler.h"
#include "src/tint/lang/core/type/struct.h"
#include "src/tint/lang/core/type/texture.h"
#include "src/tint/lang/core/type/u32.h"
#include "src/tint/lang/core/type/vector.h"
#include "src/tint/lang/core/type/void.h"
#include "src/tint/lang/msl/writer/writer.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"
#include "src/tint/utils/diagnostic/diagnostic.h"

#include "json-codec.h"
#include "override-materializer.h"
#include "request.h"

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

constexpr uint32_t kExternalBufferCeiling = 30;
constexpr uint32_t kImmediateDataIndex = 30;
constexpr uint32_t kStorageBufferSizesOffset = 4;
constexpr uint32_t kNonConstantZeroOffset = 0;
constexpr size_t kDiagnosticMessageMaxBytes = 16384;
constexpr size_t kDiagnosticMessagesTotalMaxBytes = 1024 * 1024;
constexpr size_t kMaxInventoryEntryPoints = 65536;
constexpr size_t kMaxSemanticRecords = 65536;
constexpr size_t kMaxSemanticSamplingPairs = 4096;
constexpr std::string_view kContractId = "vgpu-native-tint-compiler/v1";
constexpr std::string_view kEntryInventoryContractId =
    "vgpu-native-tint-entry-inventory/v1";
constexpr std::string_view kSemanticExtractionContractId =
    "vgpu-native-tint-semantic-extraction/v1";
constexpr std::string_view kTintRevision =
    "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";

static_assert(sizeof(float) == sizeof(uint32_t));
static_assert(std::numeric_limits<float>::is_iec559);

using Arguments = vgpu::native::CompilerRequest;
using EntryInventoryRequest = vgpu::native::EntryInventoryRequest;
using InterfaceInterpolation = vgpu::native::InterfaceInterpolation;
using InterfaceType = vgpu::native::InterfaceType;
using InterfaceValue = vgpu::native::InterfaceValue;
using Mapping = vgpu::native::Mapping;
using RequestIdentity = vgpu::native::RequestIdentity;
using SelectedEntryPoint = vgpu::native::SelectedEntryPoint;
using SemanticInterface = vgpu::native::SemanticInterface;
using SemanticExtractionRequest = vgpu::native::SemanticExtractionRequest;
namespace OverrideMaterializer = vgpu::native::overrides;

struct Location {
  std::string virtual_path;
  tint::Source::Location start;
  tint::Source::Location end;
};

struct Diagnostic {
  std::string code;
  std::string severity;
  std::string phase;
  std::string message;
  std::optional<Location> location;
};

struct EmittedSlot {
  std::string resource_class;
  uint32_t index;
  uint32_t count;
};

struct EmittedSlotsResult {
  std::optional<std::vector<EmittedSlot>> value;
  std::string error;
};

struct InterfaceResult {
  std::optional<SemanticInterface> value;
  std::string error;
};

struct InventoryEntryPoint {
  std::string stage;
  std::string wgsl;
};

struct SemanticExtractionEntryResult {
  SelectedEntryPoint entry_point;
  SemanticInterface semantic_interface;
  std::vector<std::string> bindings;
  std::vector<std::string> sampling_pairs;
  std::vector<std::string> overrides;
  std::optional<std::array<uint32_t, 3>> workgroup_size;
};

struct SemanticGraph {
  std::map<std::string, std::string> types;
  std::map<std::string, std::string> layouts;
};

struct SemanticBindingRecord {
  tint::inspector::ResourceBinding reflected;
  std::optional<std::string> type;
  std::optional<std::string> layout;
  std::optional<std::string> sample_type;
  std::optional<std::string> sampler_kind;
  std::optional<std::string> storage_format;
};

bool g_output_succeeded = true;

void EmitResponse(const std::string &response) {
  if (response.size() > vgpu::native::kMaxResponseBytes) {
    g_output_succeeded = false;
    return;
  }
  std::cout.write(response.data(),
                  static_cast<std::streamsize>(response.size()));
  std::cout.flush();
  g_output_succeeded = std::cout.good();
}

std::string JsonString(std::string_view value) {
  constexpr char kHex[] = "0123456789abcdef";
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
        output << "\\u00" << kHex[character >> 4] << kHex[character & 0x0f];
      } else {
        output << static_cast<char>(character);
      }
      break;
    }
  }
  output << '"';
  return output.str();
}

std::string BoundedDiagnosticMessage(std::string message) {
  constexpr std::string_view kSuffix = " [truncated]";
  if (message.size() <= kDiagnosticMessageMaxBytes) {
    return message;
  }
  size_t end = kDiagnosticMessageMaxBytes - kSuffix.size();
  while (end > 0 && (static_cast<unsigned char>(message[end]) & 0xc0) == 0x80) {
    --end;
  }
  message.resize(end);
  message.append(kSuffix);
  return message;
}

void WriteCompilerIdentity(std::ostream &output) {
  output << "  \"compiler\": {\"name\": \"vgpu-tint-compiler\", "
            "\"version\": \"0.1.0\", \"protocol\": 1, \"upstream\": {\"name\": "
            "\"dawn/tint\", \"revision\": "
         << JsonString(kTintRevision) << "}},\n";
}

void WriteLocation(std::ostream &output, const Location &location) {
  output << "{\"kind\": \"generated-wgsl\", \"virtualPath\": "
         << JsonString(location.virtual_path)
         << ", \"start\": {\"line\": " << location.start.line
         << ", \"column\": " << location.start.column
         << "}, \"end\": {\"line\": " << location.end.line
         << ", \"column\": " << location.end.column << "}}";
}

void WriteDiagnostics(std::ostream &output,
                      const std::vector<Diagnostic> &diagnostics) {
  output << "  \"diagnostics\": [";
  if (!diagnostics.empty()) {
    output << '\n';
  }
  for (size_t index = 0; index < diagnostics.size(); ++index) {
    const auto &diagnostic = diagnostics[index];
    output << "    {\"code\": " << JsonString(diagnostic.code)
           << ", \"severity\": " << JsonString(diagnostic.severity)
           << ", \"phase\": " << JsonString(diagnostic.phase)
           << ", \"message\": " << JsonString(diagnostic.message);
    if (diagnostic.location) {
      output << ", \"location\": ";
      WriteLocation(output, *diagnostic.location);
    }
    output << '}' << (index + 1 == diagnostics.size() ? "\n" : ",\n");
  }
  output << "  ]";
}

void WriteFailure(const std::vector<Diagnostic> &diagnostics) {
  std::ostringstream output;
  output << "{\n"
         << "  \"schemaVersion\": 1,\n"
         << "  \"contractId\": " << JsonString(kContractId) << ",\n"
         << "  \"ok\": false,\n";
  WriteCompilerIdentity(output);
  WriteDiagnostics(output, diagnostics);
  output << "\n}\n";
  EmitResponse(output.str());
}

void WriteRequestIdentity(std::ostream &output,
                          const RequestIdentity &identity) {
  output << "  \"requestIdentity\": {\"domain\": "
         << JsonString(identity.domain)
         << ", \"sha256\": " << JsonString(identity.sha256) << "},\n";
}

void WriteEntryInventoryFailure(const RequestIdentity &identity,
                                const std::vector<Diagnostic> &diagnostics) {
  std::ostringstream output;
  output << "{\n"
         << "  \"schemaVersion\": 1,\n"
         << "  \"contractId\": " << JsonString(kEntryInventoryContractId)
         << ",\n"
         << "  \"ok\": false,\n";
  WriteRequestIdentity(output, identity);
  WriteCompilerIdentity(output);
  WriteDiagnostics(output, diagnostics);
  output << "\n}\n";
  EmitResponse(output.str());
}

void WriteSemanticExtractionFailure(
    const RequestIdentity &identity,
    const std::vector<Diagnostic> &diagnostics) {
  std::ostringstream output;
  output << "{\n"
         << "  \"schemaVersion\": 1,\n"
         << "  \"contractId\": " << JsonString(kSemanticExtractionContractId)
         << ",\n"
         << "  \"ok\": false,\n";
  WriteRequestIdentity(output, identity);
  WriteCompilerIdentity(output);
  WriteDiagnostics(output, diagnostics);
  output << "\n}\n";
  EmitResponse(output.str());
}

Diagnostic Error(std::string code, std::string phase, std::string message) {
  return Diagnostic{
      .code = std::move(code),
      .severity = "error",
      .phase = std::move(phase),
      .message = BoundedDiagnosticMessage(std::move(message)),
      .location = std::nullopt,
  };
}

Diagnostic
MaterializerError(const OverrideMaterializer::Diagnostic &diagnostic) {
  const char *suffix = "INTERNAL";
  switch (diagnostic.code) {
  case OverrideMaterializer::DiagnosticCode::kNone:
  case OverrideMaterializer::DiagnosticCode::kInternal:
    suffix = "INTERNAL";
    break;
  case OverrideMaterializer::DiagnosticCode::kRequest:
    suffix = "REQUEST";
    break;
  case OverrideMaterializer::DiagnosticCode::kEntry:
    suffix = "ENTRY";
    break;
  case OverrideMaterializer::DiagnosticCode::kUnknown:
    suffix = "UNKNOWN";
    break;
  case OverrideMaterializer::DiagnosticCode::kDuplicateConfiguration:
    suffix = "DUPLICATE-CONFIGURATION";
    break;
  case OverrideMaterializer::DiagnosticCode::kWrongType:
    suffix = "WRONG-TYPE";
    break;
  case OverrideMaterializer::DiagnosticCode::kNonFinite:
    suffix = "NONFINITE";
    break;
  case OverrideMaterializer::DiagnosticCode::kOutOfRange:
    suffix = "OUT-OF-RANGE";
    break;
  case OverrideMaterializer::DiagnosticCode::kMissingRequired:
    suffix = "MISSING-REQUIRED";
    break;
  case OverrideMaterializer::DiagnosticCode::kIr:
    suffix = "IR";
    break;
  case OverrideMaterializer::DiagnosticCode::kSingleEntry:
    suffix = "SINGLE-ENTRY";
    break;
  case OverrideMaterializer::DiagnosticCode::kInvalidInitializer:
    suffix = "INVALID-INITIALIZER";
    break;
  case OverrideMaterializer::DiagnosticCode::kSubstitute:
    suffix = "SUBSTITUTE";
    break;
  }
  const char *phase = "internal";
  switch (diagnostic.phase) {
  case OverrideMaterializer::DiagnosticPhase::kRequest:
    phase = "protocol";
    break;
  case OverrideMaterializer::DiagnosticPhase::kInspect:
  case OverrideMaterializer::DiagnosticPhase::kConfiguration:
    phase = "inspect";
    break;
  case OverrideMaterializer::DiagnosticPhase::kMaterialize:
  case OverrideMaterializer::DiagnosticPhase::kVerify:
    phase = "lower";
    break;
  case OverrideMaterializer::DiagnosticPhase::kInternal:
    phase = "internal";
    break;
  }
  return Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-" + std::string(suffix),
               phase, diagnostic.message);
}

std::optional<OverrideMaterializer::PipelineStage>
MaterializerStage(std::string_view stage) {
  if (stage == "vertex") {
    return OverrideMaterializer::PipelineStage::kVertex;
  }
  if (stage == "fragment") {
    return OverrideMaterializer::PipelineStage::kFragment;
  }
  if (stage == "compute") {
    return OverrideMaterializer::PipelineStage::kCompute;
  }
  return std::nullopt;
}

tint::core::ir::Function *FindEntryFunction(tint::core::ir::Module &module,
                                            std::string_view name) {
  tint::core::ir::Function *result = nullptr;
  for (auto *function : module.functions) {
    if (function->IsEntryPoint() &&
        module.NameOf(function).NameView() == name) {
      if (result != nullptr)
        return nullptr;
      result = function;
    }
  }
  return result;
}

const char *StageName(tint::inspector::PipelineStage stage) {
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

const char *SeverityName(tint::diag::Severity severity) {
  switch (severity) {
  case tint::diag::Severity::Note:
    return "note";
  case tint::diag::Severity::Warning:
    return "warning";
  case tint::diag::Severity::Error:
    return "error";
  }
  return "error";
}

std::optional<OverrideMaterializer::ScalarType>
OverrideScalarType(tint::inspector::Override::Type type) {
  using Type = tint::inspector::Override::Type;
  switch (type) {
  case Type::kBool:
    return OverrideMaterializer::ScalarType::kBool;
  case Type::kInt32:
    return OverrideMaterializer::ScalarType::kI32;
  case Type::kUint32:
    return OverrideMaterializer::ScalarType::kU32;
  case Type::kFloat16:
    return OverrideMaterializer::ScalarType::kF16;
  case Type::kFloat32:
    return OverrideMaterializer::ScalarType::kF32;
  }
  return std::nullopt;
}

std::vector<Diagnostic>
ConvertDiagnostics(const tint::diag::List &source,
                   const tint::Source::File &authored_file,
                   const std::string &virtual_path) {
  std::vector<Diagnostic> diagnostics;
  diagnostics.reserve(std::min(source.size(), kDiagnosticMessagesTotalMaxBytes /
                                                  kDiagnosticMessageMaxBytes));
  size_t message_bytes = 0;
  bool retained_error = false;
  for (const auto &item : source) {
    std::optional<Location> location;
    const auto &range = item.source.range;
    if (item.source.file == &authored_file && range.begin.line > 0 &&
        range.begin.column > 0 && range.end.line > 0 && range.end.column > 0 &&
        range.begin <= range.end) {
      location = Location{
          .virtual_path = virtual_path,
          .start = range.begin,
          .end = range.end,
      };
    }
    Diagnostic diagnostic{
        .code = "VGPU-NATIVE-WGSL-INVALID",
        .severity = SeverityName(item.severity),
        .phase = "wgsl",
        .message = BoundedDiagnosticMessage(item.message.Plain()),
        .location = std::move(location),
    };
    if (message_bytes + diagnostic.message.size() >
        kDiagnosticMessagesTotalMaxBytes) {
      if (diagnostic.severity != "error" || retained_error) {
        continue;
      }
      while (!diagnostics.empty() && message_bytes + diagnostic.message.size() >
                                         kDiagnosticMessagesTotalMaxBytes) {
        message_bytes -= diagnostics.back().message.size();
        diagnostics.pop_back();
      }
    }
    message_bytes += diagnostic.message.size();
    retained_error = retained_error || diagnostic.severity == "error";
    diagnostics.push_back(std::move(diagnostic));
  }
  return diagnostics;
}

std::optional<std::string>
ReflectedResourceKind(tint::inspector::ResourceBinding::ResourceType type) {
  using Type = tint::inspector::ResourceBinding::ResourceType;
  switch (type) {
  case Type::kUniformBuffer:
    return "uniform";
  case Type::kStorageBuffer:
  case Type::kReadOnlyStorageBuffer:
    return "storage";
  case Type::kSampler:
    return "sampler";
  case Type::kSampledTexture:
  case Type::kMultisampledTexture:
  case Type::kDepthTexture:
  case Type::kDepthMultisampledTexture:
    return "texture";
  case Type::kWriteOnlyStorageTexture:
  case Type::kReadOnlyStorageTexture:
  case Type::kReadWriteStorageTexture:
    return "storage-texture";
  case Type::kReadOnlyTexelBuffer:
  case Type::kReadWriteTexelBuffer:
  case Type::kInputAttachment:
  case Type::kExternalTexture:
    return std::nullopt;
  }
  return std::nullopt;
}

std::optional<std::string> MappingResourceClass(const Mapping &mapping) {
  if (mapping.resource_class == "buffer" ||
      mapping.resource_class == "texture" ||
      mapping.resource_class == "sampler") {
    return mapping.resource_class;
  }
  return std::nullopt;
}

std::optional<std::string> MappingComponent(const Mapping &mapping) {
  if (mapping.component == "buffer" || mapping.component == "texture" ||
      mapping.component == "sampler") {
    return mapping.component;
  }
  return std::nullopt;
}

std::optional<std::string> ResourceClassForKind(std::string_view kind) {
  if (kind == "uniform" || kind == "storage") {
    return "buffer";
  }
  if (kind == "texture" || kind == "storage-texture") {
    return "texture";
  }
  if (kind == "sampler") {
    return "sampler";
  }
  return std::nullopt;
}

bool SameBindingPoint(const tint::BindingPoint &left,
                      const tint::BindingPoint &right) {
  return left.group == right.group && left.binding == right.binding;
}

std::optional<std::string>
ValidateRequestedMappings(const std::vector<Mapping> &mappings) {
  struct Interval {
    std::string resource_class;
    uint64_t start;
    uint64_t end;
  };
  std::vector<Interval> intervals;
  std::vector<tint::BindingPoint> sources;
  intervals.reserve(mappings.size() + 1);
  sources.reserve(mappings.size());
  for (const auto &mapping : mappings) {
    const auto resource_class = MappingResourceClass(mapping);
    const auto component = MappingComponent(mapping);
    const uint64_t end = static_cast<uint64_t>(mapping.index) + mapping.count;
    if (!resource_class || !component || *resource_class != *component) {
      return "binding mapping has an unsupported or incoherent direct "
             "component";
    }
    if (end > static_cast<uint64_t>(std::numeric_limits<uint32_t>::max()) + 1) {
      return "binding mapping interval overflows uint32";
    }
    if (*resource_class == "buffer" && end > kExternalBufferCeiling) {
      return "external buffer binding interval reaches reserved buffer(30)";
    }
    intervals.push_back(Interval{*resource_class, mapping.index, end});
    sources.push_back(mapping.source);
  }

  std::sort(sources.begin(), sources.end(),
            [](const auto &left, const auto &right) {
              return std::tie(left.group, left.binding) <
                     std::tie(right.group, right.binding);
            });
  if (std::adjacent_find(sources.begin(), sources.end(), SameBindingPoint) !=
      sources.end()) {
    return "binding mapping repeats a WGSL binding point";
  }

  intervals.push_back(
      Interval{"buffer", kImmediateDataIndex, kImmediateDataIndex + 1});
  std::sort(intervals.begin(), intervals.end(),
            [](const auto &left, const auto &right) {
              return std::tie(left.resource_class, left.start, left.end) <
                     std::tie(right.resource_class, right.start, right.end);
            });
  for (size_t index = 1; index < intervals.size(); ++index) {
    const auto &previous = intervals[index - 1];
    const auto &current = intervals[index];
    if (previous.resource_class == current.resource_class &&
        current.start < previous.end) {
      return "binding mapping contains colliding Metal intervals";
    }
  }
  return std::nullopt;
}

bool AddMapping(tint::Bindings &bindings, const Mapping &mapping) {
  const tint::BindingPoint target{.group = 0, .binding = mapping.index};
  tint::BindingMap *destination = nullptr;
  if (mapping.kind == "uniform")
    destination = &bindings.uniform;
  else if (mapping.kind == "storage")
    destination = &bindings.storage;
  else if (mapping.kind == "texture")
    destination = &bindings.texture;
  else if (mapping.kind == "storage-texture")
    destination = &bindings.storage_texture;
  else if (mapping.kind == "sampler")
    destination = &bindings.sampler;
  else
    return false;
  return destination->emplace(mapping.source, target).second;
}

std::vector<tint::BindingPoint>
RuntimeStorageBindings(tint::core::ir::Module &ir,
                       const std::string &entry_point) {
  tint::core::ir::Function *entry_function = nullptr;
  for (auto *function : ir.functions) {
    if (function->IsEntryPoint() &&
        ir.NameOf(function).NameView() == entry_point) {
      entry_function = function;
      break;
    }
  }
  std::vector<tint::BindingPoint> result;
  if (!entry_function) {
    return result;
  }
  tint::core::ir::ReferencedModuleVars<const tint::core::ir::Module>
      referenced_vars{ir};
  for (auto *variable : referenced_vars.TransitiveReferences(entry_function)) {
    const auto binding_point = variable->BindingPoint();
    const auto *pointer =
        variable->Result()->Type()->As<tint::core::type::Pointer>();
    if (binding_point && pointer &&
        pointer->AddressSpace() == tint::core::AddressSpace::kStorage &&
        !pointer->StoreType()->HasFixedFootprint()) {
      result.push_back(*binding_point);
    }
  }
  std::sort(result.begin(), result.end(),
            [](const auto &left, const auto &right) {
              return std::tie(left.group, left.binding) <
                     std::tie(right.group, right.binding);
            });
  result.erase(std::unique(result.begin(), result.end(), SameBindingPoint),
               result.end());
  return result;
}

std::optional<std::string>
ParameterResourceClass(const tint::core::type::Type *type) {
  if (type->Is<tint::core::type::MemoryView>()) {
    return "buffer";
  }
  if (type->Is<tint::core::type::Sampler>()) {
    return "sampler";
  }
  if (type->Is<tint::core::type::Texture>()) {
    return "texture";
  }
  if (const auto *binding_array = type->As<tint::core::type::BindingArray>()) {
    return ParameterResourceClass(binding_array->ElemType());
  }
  if (const auto *array = type->As<tint::core::type::Array>()) {
    return ParameterResourceClass(array->ElemType());
  }
  return std::nullopt;
}

std::optional<uint32_t>
ParameterResourceCount(const tint::core::type::Type *type) {
  if (const auto *binding_array = type->As<tint::core::type::BindingArray>()) {
    if (const auto *count = binding_array->Count()
                                ->As<tint::core::type::ConstantArrayCount>()) {
      return count->value;
    }
    return std::nullopt;
  }
  if (const auto *array = type->As<tint::core::type::Array>()) {
    return array->ConstantCount();
  }
  return 1;
}

EmittedSlotsResult ValidateEmittedSlots(tint::core::ir::Module &ir,
                                        const std::vector<Mapping> &requested) {
  std::vector<EmittedSlot> emitted;
  for (auto *function : ir.functions) {
    if (!function->IsEntryPoint()) {
      continue;
    }
    for (auto *parameter : function->Params()) {
      const auto binding = parameter->BindingPoint();
      if (!binding) {
        continue;
      }
      if (binding->group != 0) {
        return {.error = "MSL lowering emitted a nonzero binding group"};
      }
      const auto resource_class = ParameterResourceClass(parameter->Type());
      const auto resource_count = ParameterResourceCount(parameter->Type());
      if (!resource_class || !resource_count) {
        return {.error =
                    "MSL lowering emitted an unclassified bound parameter"};
      }
      const bool declared_user = std::any_of(
          requested.begin(), requested.end(), [&](const auto &mapping) {
            return MappingResourceClass(mapping) == resource_class &&
                   binding->binding == mapping.index &&
                   *resource_count == mapping.count;
          });
      const bool declared_internal = *resource_class == "buffer" &&
                                     *resource_count == 1 &&
                                     binding->binding == kImmediateDataIndex;
      if (!declared_user && !declared_internal) {
        return {.error = "MSL lowering emitted an undeclared binding"};
      }
      emitted.push_back(
          EmittedSlot{*resource_class, binding->binding, *resource_count});
    }
  }
  std::sort(emitted.begin(), emitted.end(),
            [](const auto &left, const auto &right) {
              return std::tie(left.resource_class, left.index, left.count) <
                     std::tie(right.resource_class, right.index, right.count);
            });
  for (size_t index = 1; index < emitted.size(); ++index) {
    const auto &previous = emitted[index - 1];
    const auto &current = emitted[index];
    const uint64_t previous_end =
        static_cast<uint64_t>(previous.index) + previous.count;
    if (previous.resource_class == current.resource_class &&
        current.index < previous_end) {
      return {.error = "MSL lowering emitted overlapping bindings"};
    }
  }
  for (const auto &mapping : requested) {
    if (std::none_of(emitted.begin(), emitted.end(), [&](const auto &slot) {
          return MappingResourceClass(mapping) == slot.resource_class &&
                 mapping.index == slot.index && mapping.count == slot.count;
        })) {
      return {.error = "MSL lowering omitted a requested binding"};
    }
  }
  return {.value = std::move(emitted)};
}

std::optional<InterfaceType>
InterfaceTypeFor(const tint::core::type::Type *type) {
  uint32_t width = 1;
  if (const auto *vector = type->As<tint::core::type::Vector>()) {
    width = vector->Width();
    type = vector->Type();
  }
  std::string scalar;
  if (type->Is<tint::core::type::Bool>()) {
    scalar = "bool";
  } else if (type->Is<tint::core::type::F16>()) {
    scalar = "f16";
  } else if (type->Is<tint::core::type::F32>()) {
    scalar = "f32";
  } else if (type->Is<tint::core::type::I32>()) {
    scalar = "i32";
  } else if (type->Is<tint::core::type::U32>()) {
    scalar = "u32";
  } else {
    return std::nullopt;
  }
  if (width == 0 || width > 4) {
    return std::nullopt;
  }
  return InterfaceType{.scalar = std::move(scalar), .width = width};
}

bool HasAnyInterfaceAttribute(const tint::core::IOAttributes &attributes) {
  return attributes.location || attributes.blend_src || attributes.color ||
         attributes.builtin ||
         (attributes.depth_mode &&
          *attributes.depth_mode != tint::core::BuiltinDepthMode::kUndefined) ||
         attributes.interpolation || attributes.input_attachment_index ||
         attributes.binding_point || attributes.invariant;
}

std::optional<InterfaceInterpolation>
NormalizedInterpolation(const tint::core::IOAttributes &attributes,
                        bool linked_location, std::string &error) {
  if (!linked_location) {
    if (attributes.interpolation) {
      error = "Tint retained interpolation outside an inter-stage location";
    }
    return std::nullopt;
  }
  std::string type = "perspective";
  std::string sampling = "center";
  if (attributes.interpolation) {
    type = std::string(tint::core::ToString(attributes.interpolation->type));
    sampling =
        std::string(tint::core::ToString(attributes.interpolation->sampling));
    if (type == "undefined") {
      error = "Tint produced an undefined interpolation type";
      return std::nullopt;
    }
    if (sampling == "undefined") {
      sampling = type == "flat" ? "first" : "center";
    }
  }
  const bool valid =
      ((type == "perspective" || type == "linear") &&
       (sampling == "center" || sampling == "centroid" ||
        sampling == "sample")) ||
      (type == "flat" && (sampling == "first" || sampling == "either"));
  if (!valid) {
    error = "Tint produced an unsupported interpolation pair";
    return std::nullopt;
  }
  return InterfaceInterpolation{.type = std::move(type),
                                .sampling = std::move(sampling)};
}

bool AppendInterfaceLeaf(const tint::core::type::Type *type,
                         const tint::core::IOAttributes &attributes,
                         std::string_view stage, bool input,
                         std::vector<InterfaceValue> &values,
                         std::string &error) {
  if (attributes.color) {
    error = "Tint interface contains unsupported color input metadata";
    return false;
  }
  if (attributes.depth_mode &&
      *attributes.depth_mode != tint::core::BuiltinDepthMode::kUndefined) {
    error = "Tint interface contains unsupported fragment depth mode metadata";
    return false;
  }
  if (attributes.input_attachment_index) {
    error = "Tint interface contains unsupported input attachment metadata";
    return false;
  }
  if (attributes.binding_point) {
    error = "Tint interface leaf unexpectedly contains a resource binding";
    return false;
  }
  if (attributes.location.has_value() == attributes.builtin.has_value()) {
    error = "Tint interface leaf does not have exactly one semantic key";
    return false;
  }
  const auto interface_type = InterfaceTypeFor(type);
  if (!interface_type) {
    error = "Tint interface leaf is not a scalar or vector in the v1 profile";
    return false;
  }
  const bool linked_location =
      attributes.location &&
      ((stage == "vertex" && !input) || (stage == "fragment" && input));
  auto interpolation =
      NormalizedInterpolation(attributes, linked_location, error);
  if (!error.empty()) {
    return false;
  }
  InterfaceValue value{
      .type = *interface_type,
      .invariant = attributes.invariant,
      .location = attributes.location,
      .builtin = std::nullopt,
      .interpolation = std::move(interpolation),
      .blend_source = attributes.blend_src,
  };
  if (attributes.builtin) {
    value.builtin = std::string(tint::core::ToString(*attributes.builtin));
  }
  values.push_back(std::move(value));
  return true;
}

bool AppendInterfaceType(const tint::core::type::Type *type,
                         const tint::core::IOAttributes &attributes,
                         std::string_view stage, bool input,
                         std::vector<InterfaceValue> &values,
                         std::string &error) {
  if (const auto *structure = type->As<tint::core::type::Struct>()) {
    if (HasAnyInterfaceAttribute(attributes)) {
      error = "Tint attached interface attributes to a structured container";
      return false;
    }
    for (const auto *member : structure->Members()) {
      if (member->Type()->Is<tint::core::type::Struct>() ||
          !AppendInterfaceLeaf(member->Type(), member->Attributes(), stage,
                               input, values, error)) {
        if (error.empty()) {
          error = "Tint interface nesting exceeds the flattened v1 profile";
        }
        return false;
      }
    }
    return true;
  }
  return AppendInterfaceLeaf(type, attributes, stage, input, values, error);
}

bool InterfaceValueLess(const InterfaceValue &left,
                        const InterfaceValue &right) {
  if (left.location.has_value() != right.location.has_value()) {
    return left.location.has_value();
  }
  if (left.location) {
    const uint32_t left_blend = left.blend_source ? *left.blend_source + 1 : 0;
    const uint32_t right_blend =
        right.blend_source ? *right.blend_source + 1 : 0;
    return std::tie(*left.location, left_blend) <
           std::tie(*right.location, right_blend);
  }
  return *left.builtin < *right.builtin;
}

bool SameInterfaceKey(const InterfaceValue &left, const InterfaceValue &right) {
  return !InterfaceValueLess(left, right) && !InterfaceValueLess(right, left);
}

InterfaceResult ExtractSemanticInterface(tint::core::ir::Module &ir) {
  tint::core::ir::Function *entry = nullptr;
  for (auto *function : ir.functions) {
    if (!function->IsEntryPoint()) {
      continue;
    }
    if (entry) {
      return {.error = "Tint IR contains more than one selected entry point"};
    }
    entry = function;
  }
  if (!entry) {
    return {.error = "Tint IR omits the selected entry point"};
  }
  std::string kind;
  if (entry->IsVertex()) {
    kind = "vertex";
  } else if (entry->IsFragment()) {
    kind = "fragment";
  } else if (entry->IsCompute()) {
    kind = "compute";
  } else {
    return {.error = "Tint IR selected entry point has no supported stage"};
  }

  SemanticInterface result{.kind = kind};
  std::string error;
  for (auto *parameter : entry->Params()) {
    if (parameter->BindingPoint()) {
      continue;
    }
    if (!AppendInterfaceType(parameter->Type(), parameter->Attributes(), kind,
                             true, result.inputs, error)) {
      return {.error = std::move(error)};
    }
  }
  if (!entry->ReturnType()->Is<tint::core::type::Void>() &&
      !AppendInterfaceType(entry->ReturnType(), entry->ReturnAttributes(), kind,
                           false, result.outputs, error)) {
    return {.error = std::move(error)};
  }
  const size_t maximum_inputs = kind == "compute" ? 5 : 64;
  const size_t maximum_outputs = kind == "compute" ? 0 : 64;
  if (result.inputs.size() > maximum_inputs ||
      result.outputs.size() > maximum_outputs) {
    return {.error = "Tint interface exceeds the v1 collection limit"};
  }
  std::sort(result.inputs.begin(), result.inputs.end(), InterfaceValueLess);
  std::sort(result.outputs.begin(), result.outputs.end(), InterfaceValueLess);
  if (std::adjacent_find(result.inputs.begin(), result.inputs.end(),
                         SameInterfaceKey) != result.inputs.end() ||
      std::adjacent_find(result.outputs.begin(), result.outputs.end(),
                         SameInterfaceKey) != result.outputs.end()) {
    return {.error = "Tint interface repeats a semantic key"};
  }
  return {.value = std::move(result)};
}

void WriteSemanticInterfaceValue(std::ostream &output,
                                 const InterfaceValue &value) {
  output << "{\"type\": {\"scalar\": " << JsonString(value.type.scalar)
         << ", \"width\": " << value.type.width
         << "}, \"invariant\": " << (value.invariant ? "true" : "false");
  if (value.location) {
    output << ", \"location\": " << *value.location;
  } else {
    output << ", \"builtin\": " << JsonString(*value.builtin);
  }
  if (value.interpolation) {
    output << ", \"interpolation\": {\"type\": "
           << JsonString(value.interpolation->type)
           << ", \"sampling\": " << JsonString(value.interpolation->sampling)
           << '}';
  }
  if (value.blend_source) {
    output << ", \"blendSource\": " << *value.blend_source;
  }
  output << '}';
}

void WriteSemanticInterface(std::ostream &output,
                            const SemanticInterface &shader_interface) {
  output << "{\"kind\": " << JsonString(shader_interface.kind)
         << ", \"inputs\": [";
  for (size_t index = 0; index < shader_interface.inputs.size(); ++index) {
    if (index > 0) {
      output << ", ";
    }
    WriteSemanticInterfaceValue(output, shader_interface.inputs[index]);
  }
  output << "], \"outputs\": [";
  for (size_t index = 0; index < shader_interface.outputs.size(); ++index) {
    if (index > 0) {
      output << ", ";
    }
    WriteSemanticInterfaceValue(output, shader_interface.outputs[index]);
  }
  output << "]}";
}

void WriteShaderInterface(std::ostream &output,
                          const SemanticInterface &shader_interface) {
  output << "{\"kind\": " << JsonString(shader_interface.kind);
  if (shader_interface.kind == "vertex") {
    output << ", \"attributes\": [";
    bool first = true;
    for (const auto &input : shader_interface.inputs) {
      if (!input.location) {
        continue;
      }
      if (!first) {
        output << ", ";
      }
      first = false;
      output << "{\"semantic\": {\"location\": " << *input.location
             << "}, \"metal\": {\"attribute\": " << *input.location << "}}";
    }
    output << ']';
  } else if (shader_interface.kind == "fragment") {
    output << ", \"colorOutputs\": [";
    bool first = true;
    for (const auto &shader_output : shader_interface.outputs) {
      if (!shader_output.location) {
        continue;
      }
      if (!first) {
        output << ", ";
      }
      first = false;
      output << "{\"semantic\": {\"location\": " << *shader_output.location;
      if (shader_output.blend_source) {
        output << ", \"blendSource\": " << *shader_output.blend_source;
      }
      output << "}, \"metal\": {\"color\": " << *shader_output.location;
      if (shader_output.blend_source) {
        output << ", \"index\": " << *shader_output.blend_source;
      }
      output << "}}";
    }
    output << ']';
  }
  output << '}';
}

void WriteSlot(std::ostream &output, std::string_view resource_class,
               std::string_view component, uint32_t index, uint32_t count) {
  output << "{\"mode\": \"direct\", \"resourceClass\": "
         << JsonString(resource_class)
         << ", \"component\": " << JsonString(component)
         << ", \"index\": " << index << ", \"count\": " << count << '}';
}

void EnableLanguageFeatures(const std::set<std::string> &features,
                            tint::wgsl::reader::Options &reader_options) {
  for (const auto &feature : features) {
    if (feature == "dual_source_blending") {
      reader_options.allowed_features.extensions.insert(
          tint::wgsl::Extension::kDualSourceBlending);
    } else if (feature == "f16") {
      reader_options.allowed_features.extensions.insert(
          tint::wgsl::Extension::kF16);
    } else if (feature == "uniform_buffer_standard_layout") {
      reader_options.allowed_features.features.insert(
          tint::wgsl::LanguageFeature::kUniformBufferStandardLayout);
    } else if (feature == "unrestricted_pointer_parameters") {
      reader_options.allowed_features.features.insert(
          tint::wgsl::LanguageFeature::kUnrestrictedPointerParameters);
    } else if (feature == "sized_binding_array") {
      reader_options.allowed_features.features.insert(
          tint::wgsl::LanguageFeature::kSizedBindingArray);
    }
  }
}

void WriteSuccess(const Arguments &arguments, std::vector<Mapping> mappings,
                  const std::vector<Diagnostic> &diagnostics,
                  const SemanticInterface &shader_interface,
                  const tint::msl::writer::Output &generated,
                  bool used_immediate) {
  if (generated.msl.size() > vgpu::native::kMaxMslBytes) {
    WriteFailure({Error("VGPU-NATIVE-MSL-GENERATE", "generate",
                        "generated MSL exceeds the UTF-8 byte limit")});
    return;
  }
  std::sort(mappings.begin(), mappings.end(),
            [](const auto &left, const auto &right) {
              return std::tie(left.source.group, left.source.binding, left.kind,
                              left.index, left.count) <
                     std::tie(right.source.group, right.source.binding,
                              right.kind, right.index, right.count);
            });

  std::ostringstream output;
  output << "{\n"
         << "  \"schemaVersion\": 1,\n"
         << "  \"contractId\": " << JsonString(kContractId) << ",\n"
         << "  \"ok\": true,\n";
  WriteCompilerIdentity(output);
  WriteDiagnostics(output, diagnostics);
  output << ",\n  \"result\": {\n"
         << "    \"msl\": " << JsonString(generated.msl) << ",\n"
         << "    \"entryPoint\": {\"stage\": " << JsonString(arguments.stage)
         << ", \"wgsl\": " << JsonString(arguments.entry_point)
         << ", \"metal\": " << JsonString(arguments.emitted_name) << "},\n";
  output << "    \"interface\": ";
  WriteShaderInterface(output, shader_interface);
  output << ",\n";
  if (arguments.stage == "compute") {
    output << "    \"resolvedWorkgroupSize\": {\"x\": "
           << generated.workgroup_info.x
           << ", \"y\": " << generated.workgroup_info.y
           << ", \"z\": " << generated.workgroup_info.z << "},\n";
  }
  output << "    \"bindings\": [";
  if (!mappings.empty()) {
    output << '\n';
  }
  for (size_t index = 0; index < mappings.size(); ++index) {
    const auto &mapping = mappings[index];
    const auto resource_class = MappingResourceClass(mapping);
    const auto component = MappingComponent(mapping);
    output << "      {\"group\": " << mapping.source.group
           << ", \"binding\": " << mapping.source.binding << ", \"slots\": [";
    WriteSlot(output, *resource_class, *component, mapping.index,
              mapping.count);
    output << "]}" << (index + 1 == mappings.size() ? "\n" : ",\n");
  }
  output << "    ],\n"
         << "    \"internalBindings\": [";
  if (used_immediate) {
    output << "{\"role\": \"immediate-data\", \"slots\": [";
    WriteSlot(output, "buffer", "buffer", kImmediateDataIndex, 1);
    output << "]}";
  }
  output << "],\n"
         << "    \"storageBufferSizeRegions\": [";
  if (generated.needs_storage_buffer_sizes) {
    output << "{\"stage\": " << JsonString(arguments.stage)
           << ", \"immediateDataByteOffset\": " << kStorageBufferSizesOffset
           << '}';
  }
  output << "]\n"
         << "  }\n"
         << "}\n";
  EmitResponse(output.str());
}

int Run(const Arguments &arguments) {
  auto mappings = arguments.mappings;
  if (const auto mapping_error = ValidateRequestedMappings(mappings)) {
    WriteFailure(
        {Error("VGPU-NATIVE-TINT-PROTOCOL", "protocol", *mapping_error)});
    return 2;
  }

  tint::Source::File source_file(arguments.source_name, arguments.source_text);
  tint::wgsl::reader::Options reader_options;
  EnableLanguageFeatures(arguments.features, reader_options);
  auto program = tint::wgsl::reader::Parse(&source_file, reader_options);
  auto diagnostics = ConvertDiagnostics(program.Diagnostics(), source_file,
                                        arguments.source_name);
  if (!program.IsValid()) {
    if (diagnostics.empty()) {
      diagnostics.push_back(Error("VGPU-NATIVE-WGSL-INVALID", "wgsl",
                                  "Tint rejected WGSL without a diagnostic"));
    }
    WriteFailure(diagnostics);
    return 1;
  }

  tint::inspector::Inspector inspector(program);
  const auto entry_points = inspector.GetEntryPoints();
  if (inspector.has_error()) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INSPECT", "inspect", inspector.error()));
    WriteFailure(diagnostics);
    return 1;
  }
  const auto selected = std::find_if(
      entry_points.begin(), entry_points.end(),
      [&](const auto &item) { return item.name == arguments.entry_point; });
  if (selected == entry_points.end()) {
    diagnostics.push_back(Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
                                "selected WGSL entry point was not found"));
    WriteFailure(diagnostics);
    return 1;
  }
  if (StageName(selected->stage) != arguments.stage) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
              "selected WGSL entry point has a different stage"));
    WriteFailure(diagnostics);
    return 1;
  }

  const auto reflected = inspector.GetResourceBindings(arguments.entry_point);
  if (inspector.has_error()) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INSPECT", "inspect", inspector.error()));
    WriteFailure(diagnostics);
    return 1;
  }
  if (reflected.size() != mappings.size()) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
              "binding mapping count differs from selected-entry reflection"));
    WriteFailure(diagnostics);
    return 1;
  }
  for (const auto &resource : reflected) {
    const auto kind = ReflectedResourceKind(resource.resource_type);
    const auto resource_class =
        kind ? ResourceClassForKind(*kind) : std::nullopt;
    if (!kind || !resource_class) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
                "selected entry uses an unsupported resource expansion"));
      WriteFailure(diagnostics);
      return 1;
    }
    const auto match =
        std::find_if(mappings.begin(), mappings.end(), [&](const auto &item) {
          return item.source.group == resource.bind_group &&
                 item.source.binding == resource.binding;
        });
    const uint32_t reflected_count = resource.array_size.value_or(1);
    if (match == mappings.end() || match->resource_class != *resource_class ||
        match->component != *resource_class ||
        match->count != reflected_count) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
                "binding mapping differs from selected-entry reflection"));
      WriteFailure(diagnostics);
      return 1;
    }
    match->kind = *kind;
  }
  if (std::any_of(mappings.begin(), mappings.end(),
                  [](const auto &mapping) { return mapping.kind.empty(); })) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
              "binding mapping contains an unreflected resource"));
    WriteFailure(diagnostics);
    return 1;
  }
  std::sort(mappings.begin(), mappings.end(),
            [](const auto &left, const auto &right) {
              return std::tie(left.source.group, left.source.binding,
                              left.resource_class, left.component, left.index,
                              left.count) <
                     std::tie(right.source.group, right.source.binding,
                              right.resource_class, right.component,
                              right.index, right.count);
            });

  tint::Bindings bindings;
  for (const auto &mapping : mappings) {
    if (!AddMapping(bindings, mapping)) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-PROTOCOL", "protocol",
                "binding mapping could not be represented by Tint"));
      WriteFailure(diagnostics);
      return 2;
    }
  }

  const auto named_override_ids = inspector.GetNamedOverrideIds();
  if (inspector.has_error()) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INSPECT", "inspect", inspector.error()));
    WriteFailure(diagnostics);
    return 1;
  }
  if (arguments.overrides.size() != selected->overrides.size()) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
              "request override set differs from selected-entry reflection"));
    WriteFailure(diagnostics);
    return 1;
  }
  std::set<uint16_t> reflected_override_ids;
  for (const auto &reflected_override : selected->overrides) {
    const auto value = arguments.overrides.find(reflected_override.name);
    const auto id = named_override_ids.find(reflected_override.name);
    if (value == arguments.overrides.end() || id == named_override_ids.end() ||
        id->second != reflected_override.id) {
      diagnostics.push_back(Error(
          "VGPU-NATIVE-TINT-INSPECT", "inspect",
          "request override names differ from selected-entry reflection"));
      WriteFailure(diagnostics);
      return 1;
    }
    const auto reflected_type = OverrideScalarType(reflected_override.type);
    if (!reflected_type ||
        OverrideMaterializer::ScalarTypeOf(value->second) != *reflected_type) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
                "request override type differs from Tint reflection"));
      WriteFailure(diagnostics);
      return 1;
    }
    if (!reflected_override_ids.insert(reflected_override.id.value).second) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                "Tint reflected a duplicate selected-entry override ID"));
      WriteFailure(diagnostics);
      return 1;
    }
  }

  auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (ir_result != tint::Success) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-WGSL-LOWER", "lower", ir_result.Failure().reason));
    WriteFailure(diagnostics);
    return 1;
  }
  auto &ir = ir_result.Get();

  // Install bit-exact values before pruning so configured initializers are not
  // evaluated and inactive initializer-only dependencies can be removed.
  if (const auto install =
          OverrideMaterializer::InstallValues(ir, arguments.overrides)) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INTERNAL", "internal", install->message));
    WriteFailure(diagnostics);
    return 1;
  }

  auto single_entry =
      tint::core::ir::transform::SingleEntryPoint(ir, arguments.entry_point);
  if (single_entry != tint::Success) {
    diagnostics.push_back(Error("VGPU-NATIVE-MSL-GENERATE", "generate",
                                single_entry.Failure().reason));
    WriteFailure(diagnostics);
    return 1;
  }

  tint::SubstituteOverridesConfig empty_override_config;
  auto substituted =
      tint::core::ir::transform::SubstituteOverrides(ir, empty_override_config);
  if (substituted != tint::Success) {
    diagnostics.push_back(Error("VGPU-NATIVE-MSL-GENERATE", "generate",
                                substituted.Failure().reason));
    WriteFailure(diagnostics);
    return 1;
  }
  for (const auto *instruction : ir.Instructions()) {
    if (instruction->Is<tint::core::ir::Override>()) {
      diagnostics.push_back(Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                                  "SubstituteOverrides left a live override"));
      WriteFailure(diagnostics);
      return 1;
    }
  }

  const auto core_interface = ExtractSemanticInterface(ir);
  if (!core_interface.value) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INTERFACE", "inspect", core_interface.error));
    WriteFailure(diagnostics);
    return 1;
  }
  if (*core_interface.value != arguments.semantic_interface) {
    diagnostics.push_back(Error(
        "VGPU-NATIVE-TINT-INTERFACE", "inspect",
        "request semantic interface differs from selected-entry core IR"));
    WriteFailure(diagnostics);
    return 1;
  }

  const auto runtime_storage =
      RuntimeStorageBindings(ir, arguments.entry_point);

  tint::msl::writer::ArrayLengthOptions array_lengths;
  array_lengths.buffer_sizes_offset = kStorageBufferSizesOffset;
  for (const auto &binding_point : runtime_storage) {
    const auto mapping =
        std::find_if(mappings.begin(), mappings.end(), [&](const auto &item) {
          return item.kind == "storage" &&
                 SameBindingPoint(item.source, binding_point);
        });
    if (mapping == mappings.end() || mapping->count != 1 ||
        !array_lengths.bindpoint_to_size_index
             .emplace(binding_point, mapping->index)
             .second) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-WGSL-LOWER", "lower",
                "runtime storage has no unique scalar Metal slot"));
      WriteFailure(diagnostics);
      return 1;
    }
  }

  tint::msl::writer::Options writer_options;
  writer_options.entry_point_name = arguments.entry_point;
  writer_options.remapped_entry_point_name = arguments.emitted_name;
  writer_options.bindings = bindings;
  writer_options.array_length_from_constants = std::move(array_lengths);
  writer_options.immediate_binding_point =
      tint::BindingPoint{.group = 0, .binding = kImmediateDataIndex};
  writer_options.non_constant_zero_offset = kNonConstantZeroOffset;
  auto generated = tint::msl::writer::Generate(ir, writer_options);
  if (generated != tint::Success) {
    diagnostics.push_back(Error("VGPU-NATIVE-MSL-GENERATE", "generate",
                                generated.Failure().reason));
    WriteFailure(diagnostics);
    return 1;
  }
  const auto raised_interface = ExtractSemanticInterface(ir);
  if (!raised_interface.value) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INTERNAL", "internal", raised_interface.error));
    WriteFailure(diagnostics);
    return 1;
  }
  if (*raised_interface.value != *core_interface.value) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
              "Metal raise changed the selected semantic interface"));
    WriteFailure(diagnostics);
    return 1;
  }
  const auto emitted = ValidateEmittedSlots(ir, mappings);
  if (!emitted.value) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INTERNAL", "internal", emitted.error));
    WriteFailure(diagnostics);
    return 1;
  }
  const bool used_immediate = std::any_of(
      emitted.value->begin(), emitted.value->end(), [](const auto &slot) {
        return slot.resource_class == "buffer" &&
               slot.index == kImmediateDataIndex && slot.count == 1;
      });
  if (generated->needs_storage_buffer_sizes && !used_immediate) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
              "storage-buffer-size output omitted shared immediate data"));
    WriteFailure(diagnostics);
    return 1;
  }

  WriteSuccess(arguments, mappings, diagnostics, *raised_interface.value,
               generated.Get(), used_immediate);
  return 0;
}

int InventoryStageRank(std::string_view stage) {
  if (stage == "vertex") {
    return 0;
  }
  if (stage == "fragment") {
    return 1;
  }
  if (stage == "compute") {
    return 2;
  }
  return 3;
}

bool IsInventoryIdentifier(std::string_view value) {
  if (value.empty() || value.size() > 256) {
    return false;
  }
  const auto initial = static_cast<unsigned char>(value.front());
  if (!((initial >= 'A' && initial <= 'Z') ||
        (initial >= 'a' && initial <= 'z') || initial == '_')) {
    return false;
  }
  return std::all_of(value.begin() + 1, value.end(), [](unsigned char item) {
    return (item >= 'A' && item <= 'Z') || (item >= 'a' && item <= 'z') ||
           (item >= '0' && item <= '9') || item == '_';
  });
}

void WriteEntryInventorySuccess(
    const EntryInventoryRequest &request,
    const std::vector<Diagnostic> &diagnostics,
    const std::vector<InventoryEntryPoint> &entry_points) {
  std::ostringstream output;
  output << "{\n"
         << "  \"schemaVersion\": 1,\n"
         << "  \"contractId\": " << JsonString(kEntryInventoryContractId)
         << ",\n"
         << "  \"ok\": true,\n";
  WriteRequestIdentity(output, request.identity);
  WriteCompilerIdentity(output);
  WriteDiagnostics(output, diagnostics);
  output << ",\n  \"result\": {\"entryPoints\": [";
  if (!entry_points.empty()) {
    output << '\n';
  }
  for (size_t index = 0; index < entry_points.size(); ++index) {
    const auto &entry = entry_points[index];
    output << "    {\"stage\": " << JsonString(entry.stage)
           << ", \"wgsl\": " << JsonString(entry.wgsl) << '}'
           << (index + 1 == entry_points.size() ? "\n" : ",\n");
  }
  output << "  ]}\n}\n";
  EmitResponse(output.str());
}

int Run(const EntryInventoryRequest &request) {
  tint::Source::File source_file(request.source_name, request.source_text);
  tint::wgsl::reader::Options reader_options;
  EnableLanguageFeatures(request.features, reader_options);
  auto program = tint::wgsl::reader::Parse(&source_file, reader_options);
  auto diagnostics = ConvertDiagnostics(program.Diagnostics(), source_file,
                                        request.source_name);
  if (!program.IsValid()) {
    if (diagnostics.empty()) {
      diagnostics.push_back(Error("VGPU-NATIVE-WGSL-INVALID", "wgsl",
                                  "Tint rejected WGSL without a diagnostic"));
    }
    WriteEntryInventoryFailure(request.identity, diagnostics);
    return 1;
  }

  tint::inspector::Inspector inspector(program);
  const auto inspected = inspector.GetEntryPoints();
  if (inspector.has_error()) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INSPECT", "inspect", inspector.error()));
    WriteEntryInventoryFailure(request.identity, diagnostics);
    return 1;
  }
  if (inspected.size() > kMaxInventoryEntryPoints) {
    diagnostics.push_back(Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
                                "entry points exceed the collection limit"));
    WriteEntryInventoryFailure(request.identity, diagnostics);
    return 1;
  }

  std::vector<InventoryEntryPoint> entry_points;
  entry_points.reserve(inspected.size());
  for (const auto &entry : inspected) {
    const std::string stage = StageName(entry.stage);
    if (stage == "unknown" || !IsInventoryIdentifier(entry.name)) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                "Tint returned an entry point outside the inventory contract"));
      WriteEntryInventoryFailure(request.identity, diagnostics);
      return 1;
    }
    entry_points.push_back(
        InventoryEntryPoint{.stage = stage, .wgsl = entry.name});
  }
  std::sort(entry_points.begin(), entry_points.end(),
            [](const auto &left, const auto &right) {
              const int left_rank = InventoryStageRank(left.stage);
              const int right_rank = InventoryStageRank(right.stage);
              return left_rank != right_rank ? left_rank < right_rank
                                             : left.wgsl < right.wgsl;
            });
  if (std::adjacent_find(entry_points.begin(), entry_points.end(),
                         [](const auto &left, const auto &right) {
                           return left.stage == right.stage &&
                                  left.wgsl == right.wgsl;
                         }) != entry_points.end()) {
    diagnostics.push_back(Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                                "Tint returned a duplicate entry point"));
    WriteEntryInventoryFailure(request.identity, diagnostics);
    return 1;
  }

  WriteEntryInventorySuccess(request, diagnostics, entry_points);
  return 0;
}

constexpr std::string_view kSemanticTypeIdDomain =
    "vgpu-native-semantic-type/v1";
constexpr std::string_view kSemanticLayoutIdDomain =
    "vgpu-native-semantic-layout/v1";

struct GraphIdResult {
  std::optional<std::string> value;
  std::string error;
};

std::string SemanticId(std::string_view prefix, std::string_view domain,
                       std::string_view descriptor) {
  return std::string(prefix) +
         vgpu::native::DomainSeparatedSha256(domain, descriptor);
}

bool InsertGraphRecord(std::map<std::string, std::string> &records,
                       const std::string &id, const std::string &descriptor) {
  if (!records.contains(id) && records.size() >= kMaxSemanticRecords) {
    return false;
  }
  const auto [item, inserted] = records.emplace(id, descriptor);
  return inserted || item->second == descriptor;
}

GraphIdResult InternSemanticType(const tint::core::type::Type *type,
                                 SemanticGraph &graph) {
  std::string descriptor;
  if (type->Is<tint::core::type::F16>()) {
    descriptor = "{\"kind\":\"scalar\",\"scalar\":\"f16\"}";
  } else if (type->Is<tint::core::type::F32>()) {
    descriptor = "{\"kind\":\"scalar\",\"scalar\":\"f32\"}";
  } else if (type->Is<tint::core::type::I32>()) {
    descriptor = "{\"kind\":\"scalar\",\"scalar\":\"i32\"}";
  } else if (type->Is<tint::core::type::U32>()) {
    descriptor = "{\"kind\":\"scalar\",\"scalar\":\"u32\"}";
  } else if (const auto *atomic = type->As<tint::core::type::Atomic>()) {
    auto element = InternSemanticType(atomic->Type(), graph);
    if (!element.value)
      return element;
    descriptor =
        "{\"element\":" + JsonString(*element.value) + ",\"kind\":\"atomic\"}";
  } else if (const auto *vector = type->As<tint::core::type::Vector>()) {
    auto element = InternSemanticType(vector->Type(), graph);
    if (!element.value)
      return element;
    if (vector->Packed() || vector->Width() < 2 || vector->Width() > 4) {
      return {.error = "buffer graph contains an unsupported vector"};
    }
    descriptor =
        "{\"element\":" + JsonString(*element.value) +
        ",\"kind\":\"vector\",\"width\":" + std::to_string(vector->Width()) +
        "}";
  } else if (const auto *matrix = type->As<tint::core::type::Matrix>()) {
    auto element = InternSemanticType(matrix->Type(), graph);
    if (!element.value)
      return element;
    if (matrix->Columns() < 2 || matrix->Columns() > 4 || matrix->Rows() < 2 ||
        matrix->Rows() > 4) {
      return {.error = "buffer graph contains an unsupported matrix"};
    }
    descriptor =
        "{\"columns\":" + std::to_string(matrix->Columns()) +
        ",\"element\":" + JsonString(*element.value) +
        ",\"kind\":\"matrix\",\"rows\":" + std::to_string(matrix->Rows()) + "}";
  } else if (const auto *array = type->As<tint::core::type::Array>()) {
    const auto count = array->ConstantCount();
    auto element = InternSemanticType(array->ElemType(), graph);
    if (!element.value)
      return element;
    if (count && *count > 0) {
      descriptor = "{\"count\":" + std::to_string(*count) +
                   ",\"element\":" + JsonString(*element.value) +
                   ",\"kind\":\"array\"}";
    } else if (array->Count()->Is<tint::core::type::RuntimeArrayCount>()) {
      descriptor =
          "{\"element\":" + JsonString(*element.value) + ",\"kind\":\"array\"}";
    } else {
      return {.error = "buffer graph contains an unresolved array count"};
    }
  } else if (const auto *structure = type->As<tint::core::type::Struct>()) {
    if (structure->IsWgslInternal() ||
        !IsInventoryIdentifier(structure->Name().Name())) {
      return {.error = "buffer graph contains an unsupported structure name"};
    }
    std::ostringstream members;
    members << '[';
    for (size_t index = 0; index < structure->Members().Length(); ++index) {
      const auto *member = structure->Members()[index];
      if (!IsInventoryIdentifier(member->Name().Name())) {
        return {.error = "buffer graph contains an unsupported member name"};
      }
      auto child = InternSemanticType(member->Type(), graph);
      if (!child.value)
        return child;
      if (index > 0)
        members << ',';
      members << "{\"name\":" << JsonString(member->Name().Name())
              << ",\"type\":" << JsonString(*child.value) << '}';
    }
    members << ']';
    descriptor = "{\"kind\":\"struct\",\"members\":" + members.str() +
                 ",\"wgslName\":" + JsonString(structure->Name().Name()) + "}";
  } else {
    return {.error = "buffer graph contains a type outside semantic v1"};
  }
  const auto id = SemanticId("t_", kSemanticTypeIdDomain, descriptor);
  if (!InsertGraphRecord(graph.types, id, descriptor)) {
    return {.error = "semantic type identity collision or collection limit"};
  }
  return {.value = id};
}

std::optional<uint32_t>
SemanticLayoutMinimumSize(const tint::core::type::Type *type) {
  if (type->HasFixedFootprint()) {
    return type->Size();
  }
  if (const auto *array = type->As<tint::core::type::Array>()) {
    if (array->Count()->Is<tint::core::type::RuntimeArrayCount>()) {
      return 0;
    }
    return std::nullopt;
  }
  if (const auto *structure = type->As<tint::core::type::Struct>()) {
    if (structure->Members().IsEmpty()) {
      return std::nullopt;
    }
    const auto *last = structure->Members().Back();
    const auto child = SemanticLayoutMinimumSize(last->Type());
    if (!child ||
        *child > std::numeric_limits<uint32_t>::max() - last->Offset()) {
      return std::nullopt;
    }
    return last->Offset() + *child;
  }
  return std::nullopt;
}

GraphIdResult InternSemanticLayout(const tint::core::type::Type *type,
                                   SemanticGraph &graph) {
  if (!type->IsHostShareable()) {
    return {.error = "buffer graph contains a non-host-shareable layout"};
  }
  const auto minimum_size = SemanticLayoutMinimumSize(type);
  if (!minimum_size) {
    return {.error = "buffer graph contains an unsupported runtime layout"};
  }
  const bool runtime_sized = !type->HasFixedFootprint();
  auto type_id = InternSemanticType(type, graph);
  if (!type_id.value)
    return type_id;
  std::ostringstream descriptor;
  descriptor << "{\"alignment\":" << type->Align();
  if (const auto *array = type->As<tint::core::type::Array>()) {
    auto element_layout = InternSemanticLayout(array->ElemType(), graph);
    if (!element_layout.value)
      return element_layout;
    descriptor << ",\"arrayStride\":" << array->ImplicitStride()
               << ",\"elementLayout\":" << JsonString(*element_layout.value);
  }
  const auto *structure = type->As<tint::core::type::Struct>();
  const auto *matrix = type->As<tint::core::type::Matrix>();
  if (matrix) {
    descriptor << ",\"matrixStride\":" << matrix->ColumnStride();
  }
  descriptor << ",\"members\":[";
  if (structure) {
    for (size_t index = 0; index < structure->Members().Length(); ++index) {
      const auto *member = structure->Members()[index];
      auto child_type = InternSemanticType(member->Type(), graph);
      if (!child_type.value)
        return child_type;
      auto child_layout = InternSemanticLayout(member->Type(), graph);
      if (!child_layout.value)
        return child_layout;
      const auto child_minimum = SemanticLayoutMinimumSize(member->Type());
      if (!child_minimum) {
        return {.error = "buffer graph contains an unsupported member layout"};
      }
      const bool member_runtime_sized = !member->Type()->HasFixedFootprint();
      if (index > 0)
        descriptor << ',';
      descriptor << "{\"alignment\":" << member->Align()
                 << ",\"layout\":" << JsonString(*child_layout.value)
                 << ",\"minimumSize\":"
                 << (member_runtime_sized ? *child_minimum : member->Size())
                 << ",\"name\":" << JsonString(member->Name().Name())
                 << ",\"offset\":" << member->Offset() << ",\"runtimeSized\":"
                 << (member_runtime_sized ? "true" : "false");
      if (!member_runtime_sized) {
        descriptor << ",\"size\":" << member->Size();
      }
      descriptor << ",\"type\":" << JsonString(*child_type.value) << '}';
    }
  }
  descriptor << "],\"minimumSize\":" << *minimum_size
             << ",\"runtimeSized\":" << (runtime_sized ? "true" : "false");
  if (!runtime_sized) {
    descriptor << ",\"size\":" << type->Size();
  }
  descriptor << ",\"type\":" << JsonString(*type_id.value) << '}';
  const auto json = descriptor.str();
  const auto id = SemanticId("l_", kSemanticLayoutIdDomain, json);
  if (!InsertGraphRecord(graph.layouts, id, json)) {
    return {.error = "semantic layout identity collision or collection limit"};
  }
  return {.value = id};
}

std::string BindingId(uint32_t group, uint32_t binding) {
  return "g" + std::to_string(group) + "b" + std::to_string(binding);
}

const char *TextureDimensionName(
    tint::inspector::ResourceBinding::TextureDimension dimension) {
  using Dimension = tint::inspector::ResourceBinding::TextureDimension;
  switch (dimension) {
  case Dimension::k1d:
    return "1d";
  case Dimension::k2d:
    return "2d";
  case Dimension::k2dArray:
    return "2d-array";
  case Dimension::k3d:
    return "3d";
  case Dimension::kCube:
    return "cube";
  case Dimension::kCubeArray:
    return "cube-array";
  case Dimension::kNone:
    break;
  }
  return nullptr;
}

std::optional<std::string>
InitialSampleType(const tint::inspector::ResourceBinding &resource) {
  using Kind = tint::inspector::ResourceBinding::SampledKind;
  switch (resource.sampled_kind) {
  case Kind::kFloat:
  case Kind::kFilterable:
    return "float";
  case Kind::kUnfilterable:
    return "unfilterable-float";
  case Kind::kUInt:
    return "uint";
  case Kind::kSInt:
    return "sint";
  case Kind::kUnknownFilterable:
    return "unknown";
  }
  return std::nullopt;
}

std::optional<std::string>
InitialSamplerKind(const tint::inspector::ResourceBinding &resource) {
  using Kind = tint::inspector::ResourceBinding::SamplerType;
  switch (resource.sampler_type) {
  case Kind::kComparison:
    return "comparison";
  case Kind::kFiltering:
    return "filtering";
  case Kind::kNonFiltering:
    return "non-filtering";
  case Kind::kUnknownFiltering:
    return "unknown";
  }
  return std::nullopt;
}

std::optional<std::string>
StorageTextureFormat(tint::inspector::ResourceBinding::TexelFormat format) {
  using Format = tint::inspector::ResourceBinding::TexelFormat;
  switch (format) {
  case Format::kR8Snorm:
    return "r8snorm";
  case Format::kR8Unorm:
    return "r8unorm";
  case Format::kR8Uint:
    return "r8uint";
  case Format::kR8Sint:
    return "r8sint";
  case Format::kRg8Unorm:
    return "rg8unorm";
  case Format::kRg8Snorm:
    return "rg8snorm";
  case Format::kRg8Uint:
    return "rg8uint";
  case Format::kRg8Sint:
    return "rg8sint";
  case Format::kR16Unorm:
    return "r16unorm";
  case Format::kR16Snorm:
    return "r16snorm";
  case Format::kR16Uint:
    return "r16uint";
  case Format::kR16Sint:
    return "r16sint";
  case Format::kR16Float:
    return "r16float";
  case Format::kRg16Unorm:
    return "rg16unorm";
  case Format::kRg16Snorm:
    return "rg16snorm";
  case Format::kRg16Uint:
    return "rg16uint";
  case Format::kRg16Sint:
    return "rg16sint";
  case Format::kRg16Float:
    return "rg16float";
  case Format::kBgra8Unorm:
    return "bgra8unorm";
  case Format::kRgba8Unorm:
    return "rgba8unorm";
  case Format::kRgba8Snorm:
    return "rgba8snorm";
  case Format::kRgba8Uint:
    return "rgba8uint";
  case Format::kRgba8Sint:
    return "rgba8sint";
  case Format::kRgba16Unorm:
    return "rgba16unorm";
  case Format::kRgba16Snorm:
    return "rgba16snorm";
  case Format::kRgba16Uint:
    return "rgba16uint";
  case Format::kRgba16Sint:
    return "rgba16sint";
  case Format::kRgba16Float:
    return "rgba16float";
  case Format::kR32Uint:
    return "r32uint";
  case Format::kR32Sint:
    return "r32sint";
  case Format::kR32Float:
    return "r32float";
  case Format::kRg32Uint:
    return "rg32uint";
  case Format::kRg32Sint:
    return "rg32sint";
  case Format::kRg32Float:
    return "rg32float";
  case Format::kRgba32Uint:
    return "rgba32uint";
  case Format::kRgba32Sint:
    return "rgba32sint";
  case Format::kRgba32Float:
    return "rgba32float";
  case Format::kRgb10A2Uint:
    return "rgb10a2uint";
  case Format::kRgb10A2Unorm:
    return "rgb10a2unorm";
  case Format::kRg11B10Ufloat:
    return "rg11b10ufloat";
  case Format::kNone:
    return std::nullopt;
  }
  return std::nullopt;
}

struct BufferStoreTypeResult {
  const tint::core::type::Type *type = nullptr;
  bool duplicate = false;
};

BufferStoreTypeResult BufferStoreType(tint::core::ir::Module &ir,
                                      uint32_t group, uint32_t binding) {
  BufferStoreTypeResult result;
  for (const auto *instruction : *ir.root_block) {
    const auto *variable = instruction->As<tint::core::ir::Var>();
    if (!variable)
      continue;
    const auto point = variable->BindingPoint();
    const auto *pointer =
        variable->Result()->Type()->As<tint::core::type::Pointer>();
    if (point && point->group == group && point->binding == binding &&
        pointer) {
      if (result.type) {
        result.duplicate = true;
      } else {
        result.type = pointer->StoreType();
      }
    }
  }
  return result;
}

bool SameSemanticBinding(const SemanticBindingRecord &left,
                         const SemanticBindingRecord &right) {
  const auto &a = left.reflected;
  const auto &b = right.reflected;
  return a.resource_type == b.resource_type && a.bind_group == b.bind_group &&
         a.binding == b.binding && a.variable_name == b.variable_name &&
         a.dim == b.dim && left.type == right.type &&
         left.layout == right.layout && left.sample_type == right.sample_type &&
         left.sampler_kind == right.sampler_kind &&
         left.storage_format == right.storage_format;
}

std::optional<std::string>
SemanticBindingJson(const SemanticBindingRecord &binding) {
  using Resource = tint::inspector::ResourceBinding;
  const auto &value = binding.reflected;
  const auto id = BindingId(value.bind_group, value.binding);
  std::ostringstream output;
  output << "{\"binding\":" << value.binding
         << ",\"group\":" << value.bind_group << ",\"id\":" << JsonString(id);
  switch (value.resource_type) {
  case Resource::ResourceType::kUniformBuffer:
  case Resource::ResourceType::kStorageBuffer:
  case Resource::ResourceType::kReadOnlyStorageBuffer:
    if (!binding.type || !binding.layout)
      return std::nullopt;
    output << ",\"kind\":\"buffer\",\"name\":"
           << JsonString(value.variable_name) << ",\"addressSpace\":"
           << JsonString(value.resource_type ==
                                 Resource::ResourceType::kUniformBuffer
                             ? "uniform"
                             : "storage")
           << ",\"access\":"
           << JsonString(value.resource_type ==
                                 Resource::ResourceType::kStorageBuffer
                             ? "read_write"
                             : "read")
           << ",\"layout\":" << JsonString(*binding.layout)
           << ",\"minimumBindingSize\":" << value.size
           << ",\"type\":" << JsonString(*binding.type) << '}';
    return output.str();
  case Resource::ResourceType::kSampler:
    if (!binding.sampler_kind || *binding.sampler_kind == "unknown") {
      return std::nullopt;
    }
    output << ",\"kind\":\"sampler\",\"name\":"
           << JsonString(value.variable_name)
           << ",\"samplerKind\":" << JsonString(*binding.sampler_kind) << '}';
    return output.str();
  case Resource::ResourceType::kSampledTexture:
  case Resource::ResourceType::kMultisampledTexture:
  case Resource::ResourceType::kDepthTexture:
  case Resource::ResourceType::kDepthMultisampledTexture: {
    const auto *dimension = TextureDimensionName(value.dim);
    const bool depth =
        value.resource_type == Resource::ResourceType::kDepthTexture ||
        value.resource_type ==
            Resource::ResourceType::kDepthMultisampledTexture;
    if (!dimension || (!depth && (!binding.sample_type ||
                                  *binding.sample_type == "unknown"))) {
      return std::nullopt;
    }
    const bool multisampled =
        value.resource_type == Resource::ResourceType::kMultisampledTexture ||
        value.resource_type ==
            Resource::ResourceType::kDepthMultisampledTexture;
    output << ",\"kind\":\"texture\",\"name\":"
           << JsonString(value.variable_name)
           << ",\"dimension\":" << JsonString(dimension) << ",\"sampleType\":"
           << JsonString(depth ? "depth" : *binding.sample_type)
           << ",\"multisampled\":" << (multisampled ? "true" : "false") << '}';
    return output.str();
  }
  case Resource::ResourceType::kExternalTexture:
    output << ",\"kind\":\"external-texture\",\"name\":"
           << JsonString(value.variable_name) << '}';
    return output.str();
  case Resource::ResourceType::kWriteOnlyStorageTexture:
  case Resource::ResourceType::kReadOnlyStorageTexture:
  case Resource::ResourceType::kReadWriteStorageTexture: {
    const auto *dimension = TextureDimensionName(value.dim);
    if (!dimension || !binding.storage_format ||
        std::string_view(dimension) == "cube" ||
        std::string_view(dimension) == "cube-array") {
      return std::nullopt;
    }
    const auto access =
        value.resource_type == Resource::ResourceType::kWriteOnlyStorageTexture
            ? "write"
        : value.resource_type == Resource::ResourceType::kReadOnlyStorageTexture
            ? "read"
            : "read_write";
    output << ",\"kind\":\"storage-texture\",\"name\":"
           << JsonString(value.variable_name)
           << ",\"dimension\":" << JsonString(dimension)
           << ",\"format\":" << JsonString(*binding.storage_format)
           << ",\"access\":" << JsonString(access) << '}';
    return output.str();
  }
  default:
    return std::nullopt;
  }
}

bool IsTextureBinding(const SemanticBindingRecord &binding) {
  using Type = tint::inspector::ResourceBinding::ResourceType;
  return binding.reflected.resource_type == Type::kSampledTexture ||
         binding.reflected.resource_type == Type::kMultisampledTexture ||
         binding.reflected.resource_type == Type::kDepthTexture ||
         binding.reflected.resource_type == Type::kDepthMultisampledTexture ||
         binding.reflected.resource_type == Type::kExternalTexture;
}

bool IsExternalTextureBinding(const SemanticBindingRecord &binding) {
  return binding.reflected.resource_type ==
         tint::inspector::ResourceBinding::ResourceType::kExternalTexture;
}

void ResolveUnknownBindingKinds(
    std::map<std::string, SemanticBindingRecord> &bindings,
    const std::vector<std::pair<std::string, std::string>> &pairs) {
  for (const auto &[texture_id, sampler_id] : pairs) {
    auto texture = bindings.find(texture_id);
    auto sampler = bindings.find(sampler_id);
    if (texture == bindings.end() || sampler == bindings.end() ||
        IsExternalTextureBinding(texture->second)) {
      continue;
    }
    if (sampler->second.sampler_kind == "unknown" &&
        texture->second.sample_type &&
        (*texture->second.sample_type == "unfilterable-float" ||
         *texture->second.sample_type == "sint" ||
         *texture->second.sample_type == "uint")) {
      sampler->second.sampler_kind = "non-filtering";
    }
  }
  for (auto &[id, binding] : bindings) {
    if (binding.sampler_kind == "unknown")
      binding.sampler_kind = "filtering";
  }
  for (const auto &[texture_id, sampler_id] : pairs) {
    auto texture = bindings.find(texture_id);
    auto sampler = bindings.find(sampler_id);
    if (texture != bindings.end() && sampler != bindings.end() &&
        texture->second.sample_type == "unknown" &&
        sampler->second.sampler_kind == "filtering") {
      texture->second.sample_type = "float";
    }
  }
  for (auto &[id, binding] : bindings) {
    if (binding.sample_type == "unknown") {
      binding.sample_type = "unfilterable-float";
    }
  }
}

bool ResolvedPairsAreCoherent(
    const std::map<std::string, SemanticBindingRecord> &bindings,
    const std::vector<std::pair<std::string, std::string>> &pairs) {
  for (const auto &[texture_id, sampler_id] : pairs) {
    const auto &texture = bindings.at(texture_id);
    const auto &sampler = bindings.at(sampler_id);
    if (sampler.sampler_kind == "comparison") {
      using Type = tint::inspector::ResourceBinding::ResourceType;
      if (texture.reflected.resource_type != Type::kDepthTexture &&
          texture.reflected.resource_type != Type::kDepthMultisampledTexture) {
        return false;
      }
    } else if (sampler.sampler_kind == "filtering") {
      if (texture.sample_type == "unfilterable-float" ||
          texture.sample_type == "sint" || texture.sample_type == "uint") {
        return false;
      }
    } else if (sampler.sampler_kind == "non-filtering") {
      if (texture.sample_type != "unfilterable-float" &&
          texture.sample_type != "sint" && texture.sample_type != "uint") {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

std::string ScalarValueJson(const OverrideMaterializer::ScalarValue &value) {
  std::ostringstream output;
  output << "{\"type\":"
         << JsonString(OverrideMaterializer::ScalarTypeName(
                OverrideMaterializer::ScalarTypeOf(value)));
  if (const auto *boolean = std::get_if<bool>(&value)) {
    output << ",\"value\":" << (*boolean ? "true" : "false");
  } else if (const auto *integer = std::get_if<int32_t>(&value)) {
    output << ",\"value\":" << *integer;
  } else if (const auto *integer = std::get_if<uint32_t>(&value)) {
    output << ",\"value\":" << *integer;
  } else if (const auto *f16 =
                 std::get_if<OverrideMaterializer::F16Bits>(&value)) {
    output << ",\"bits\":\"" << std::hex << std::setfill('0') << std::setw(4)
           << f16->bits << '\"';
  } else {
    const auto &f32 = std::get<OverrideMaterializer::F32Bits>(value);
    output << ",\"bits\":\"" << std::hex << std::setfill('0') << std::setw(8)
           << f32.bits << '\"';
  }
  output << '}';
  return output.str();
}

std::optional<std::string> PreflightSemanticOverrides(
    const OverrideMaterializer::Materialization &materialization,
    const std::vector<SemanticExtractionEntryResult> &entries) {
  if (materialization.overrides.size() > 4096 ||
      materialization.entries.size() != entries.size()) {
    return "materialized override response exceeds its collection shape";
  }
  std::map<std::string, const OverrideMaterializer::OverrideRecord *> records;
  std::set<uint16_t> authored_ids;
  std::optional<std::string> previous_name;
  for (const auto &record : materialization.overrides) {
    if (!IsInventoryIdentifier(record.name) ||
        (previous_name && *previous_name >= record.name) ||
        !records.emplace(record.name, &record).second ||
        (record.wgsl_id && !authored_ids.insert(*record.wgsl_id).second) ||
        (record.default_result.status ==
         OverrideMaterializer::DefaultStatus::kValue) !=
            record.default_result.value.has_value() ||
        (record.default_result.value &&
         OverrideMaterializer::ScalarTypeOf(*record.default_result.value) !=
             OverrideMaterializer::ScalarTypeOf(record.selected))) {
      return "materialized override record cannot be represented on the wire";
    }
    previous_name = record.name;
  }
  size_t memberships = 0;
  std::set<std::string> union_names;
  for (size_t index = 0; index < entries.size(); ++index) {
    if (materialization.entries[index].name !=
            entries[index].entry_point.wgsl ||
        OverrideMaterializer::PipelineStageName(
            materialization.entries[index].stage) !=
            entries[index].entry_point.stage ||
        materialization.entries[index].exact_override_names !=
            entries[index].overrides) {
      return "materialized override entry projection drifted";
    }
    const bool compute = entries[index].entry_point.stage == "compute";
    if (compute != entries[index].workgroup_size.has_value() ||
        (entries[index].workgroup_size &&
         std::any_of(entries[index].workgroup_size->begin(),
                     entries[index].workgroup_size->end(),
                     [](uint32_t value) { return value == 0; }))) {
      return "materialized workgroup size cannot be represented on the wire";
    }
    memberships += entries[index].overrides.size();
    if (memberships > 8192 ||
        !std::is_sorted(entries[index].overrides.begin(),
                        entries[index].overrides.end()) ||
        std::adjacent_find(entries[index].overrides.begin(),
                           entries[index].overrides.end()) !=
            entries[index].overrides.end()) {
      return "materialized override memberships cannot be represented";
    }
    for (const auto &name : entries[index].overrides) {
      if (!records.contains(name)) {
        return "materialized override membership has no program record";
      }
      union_names.insert(name);
    }
  }
  if (union_names.size() != records.size()) {
    return "materialized program overrides are not the exact entry union";
  }
  return std::nullopt;
}

void WriteSemanticExtractionSuccess(
    const SemanticExtractionRequest &request,
    const std::vector<Diagnostic> &diagnostics,
    const std::vector<SemanticExtractionEntryResult> &entry_points,
    const std::map<std::string, SemanticBindingRecord> &bindings,
    const SemanticGraph &graph,
    const OverrideMaterializer::Materialization &materialization) {
  std::ostringstream output;
  output << "{\n"
         << "  \"schemaVersion\": 1,\n"
         << "  \"contractId\": " << JsonString(kSemanticExtractionContractId)
         << ",\n"
         << "  \"ok\": true,\n";
  WriteRequestIdentity(output, request.identity);
  WriteCompilerIdentity(output);
  WriteDiagnostics(output, diagnostics);
  output << ",\n  \"result\": {\n    \"entryPoints\": [\n";
  for (size_t index = 0; index < entry_points.size(); ++index) {
    const auto &entry = entry_points[index];
    output << "      {\"stage\": " << JsonString(entry.entry_point.stage)
           << ", \"wgsl\": " << JsonString(entry.entry_point.wgsl)
           << ", \"semanticInterface\": ";
    WriteSemanticInterface(output, entry.semantic_interface);
    output << ", \"bindings\": [";
    for (size_t binding_index = 0; binding_index < entry.bindings.size();
         ++binding_index) {
      if (binding_index > 0)
        output << ", ";
      output << JsonString(entry.bindings[binding_index]);
    }
    output << "], \"samplingPairs\": [";
    for (size_t pair_index = 0; pair_index < entry.sampling_pairs.size();
         ++pair_index) {
      if (pair_index > 0)
        output << ", ";
      output << entry.sampling_pairs[pair_index];
    }
    output << "], \"overrides\": [";
    for (size_t override_index = 0; override_index < entry.overrides.size();
         ++override_index) {
      if (override_index > 0)
        output << ", ";
      output << JsonString(entry.overrides[override_index]);
    }
    output << ']';
    if (entry.workgroup_size) {
      output << ", \"workgroupSize\": {\"x\": " << (*entry.workgroup_size)[0]
             << ", \"y\": " << (*entry.workgroup_size)[1]
             << ", \"z\": " << (*entry.workgroup_size)[2] << '}';
    }
    output << '}' << (index + 1 == entry_points.size() ? "\n" : ",\n");
  }
  output << "    ],\n";
  if (bindings.empty()) {
    output << "    \"bindings\": [],\n";
  } else {
    output << "    \"bindings\": [";
  }
  bool first = true;
  std::vector<const SemanticBindingRecord *> ordered_bindings;
  ordered_bindings.reserve(bindings.size());
  for (const auto &[id, binding] : bindings)
    ordered_bindings.push_back(&binding);
  std::sort(
      ordered_bindings.begin(), ordered_bindings.end(),
      [](const auto *left, const auto *right) {
        return std::tie(left->reflected.bind_group, left->reflected.binding) <
               std::tie(right->reflected.bind_group, right->reflected.binding);
      });
  for (const auto *binding : ordered_bindings) {
    const auto json = SemanticBindingJson(*binding);
    if (!json)
      continue;
    if (!first)
      output << ",";
    output << "\n      " << *json;
    first = false;
  }
  if (!bindings.empty()) {
    output << '\n' << "    ],\n";
  }
  output << "    \"overrides\": [";
  for (size_t index = 0; index < materialization.overrides.size(); ++index) {
    const auto &record = materialization.overrides[index];
    if (index > 0)
      output << ',';
    output << "\n      {\"name\":" << JsonString(record.name);
    if (record.wgsl_id) {
      output << ",\"wgslId\":" << *record.wgsl_id;
    }
    output << ",\"type\":"
           << JsonString(OverrideMaterializer::ScalarTypeName(
                  OverrideMaterializer::ScalarTypeOf(record.selected)));
    if (record.default_result.status ==
        OverrideMaterializer::DefaultStatus::kValue) {
      output << ",\"default\":"
             << ScalarValueJson(*record.default_result.value);
    }
    output << ",\"selected\":" << ScalarValueJson(record.selected) << '}';
  }
  if (!materialization.overrides.empty())
    output << '\n' << "    ";
  output << "],\n";
  if (graph.types.empty()) {
    output << "    \"types\": {},\n";
  } else {
    output << "    \"types\": {";
  }
  first = true;
  for (const auto &[id, descriptor] : graph.types) {
    if (!first)
      output << ',';
    output << "\n      " << JsonString(id) << ": " << descriptor;
    first = false;
  }
  if (!graph.types.empty())
    output << "\n    },\n";
  if (graph.layouts.empty()) {
    output << "    \"layouts\": {}\n";
  } else {
    output << "    \"layouts\": {";
  }
  first = true;
  for (const auto &[id, descriptor] : graph.layouts) {
    if (!first)
      output << ',';
    output << "\n      " << JsonString(id) << ": " << descriptor;
    first = false;
  }
  if (!graph.layouts.empty())
    output << "\n    }\n";
  output << "  }\n}\n";
  EmitResponse(output.str());
}

int Run(const SemanticExtractionRequest &request) {
  tint::Source::File source_file(request.source_name, request.source_text);
  tint::wgsl::reader::Options reader_options;
  EnableLanguageFeatures(request.features, reader_options);
  auto program = tint::wgsl::reader::Parse(&source_file, reader_options);
  auto diagnostics = ConvertDiagnostics(program.Diagnostics(), source_file,
                                        request.source_name);
  if (!program.IsValid()) {
    if (diagnostics.empty()) {
      diagnostics.push_back(Error("VGPU-NATIVE-WGSL-INVALID", "wgsl",
                                  "Tint rejected WGSL without a diagnostic"));
    }
    WriteSemanticExtractionFailure(request.identity, diagnostics);
    return 1;
  }

  tint::inspector::Inspector inspector(program);
  const auto inspected = inspector.GetEntryPoints();
  if (inspector.has_error()) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INSPECT", "inspect", inspector.error()));
    WriteSemanticExtractionFailure(request.identity, diagnostics);
    return 1;
  }

  std::vector<const tint::inspector::EntryPoint *> selected;
  selected.reserve(request.entry_points.size());
  for (const auto &requested : request.entry_points) {
    const auto match = std::find_if(
        inspected.begin(), inspected.end(),
        [&](const auto &entry) { return entry.name == requested.wgsl; });
    if (match == inspected.end()) {
      diagnostics.push_back(Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
                                  "selected WGSL entry point was not found"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    if (StageName(match->stage) != requested.stage) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
                "selected WGSL entry point has a different stage"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    selected.push_back(&*match);
  }

  std::vector<OverrideMaterializer::SelectedEntry> materializer_entries;
  materializer_entries.reserve(request.entry_points.size());
  for (const auto &entry : request.entry_points) {
    const auto stage = MaterializerStage(entry.stage);
    if (!stage) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-ENTRY", "inspect",
                "selected entry has no materializer pipeline stage"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    materializer_entries.push_back(OverrideMaterializer::SelectedEntry{
        .name = entry.wgsl, .stage = *stage});
  }
  const auto materializer_result = OverrideMaterializer::Materialize(
      program, materializer_entries, request.override_configuration);
  const auto *materializer_diagnostic =
      std::get_if<OverrideMaterializer::Diagnostic>(&materializer_result);
  if (materializer_diagnostic != nullptr) {
    diagnostics.push_back(MaterializerError(*materializer_diagnostic));
    WriteSemanticExtractionFailure(request.identity, diagnostics);
    return 1;
  }
  const auto &materialization =
      std::get<OverrideMaterializer::Materialization>(materializer_result);
  std::map<std::string, OverrideMaterializer::ScalarValue>
      program_override_values;
  for (const auto &record : materialization.overrides) {
    if (!program_override_values.emplace(record.name, record.selected).second) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-INTERNAL", "internal",
                "materializer returned duplicate program override names"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
  }

  std::vector<std::vector<tint::inspector::ResourceBinding>> entry_resources;
  std::vector<std::vector<tint::inspector::SamplerTexturePair>>
      entry_pair_points;
  entry_resources.reserve(selected.size());
  entry_pair_points.reserve(selected.size());
  for (const auto *entry : selected) {
    const auto resources = inspector.GetResourceBindings(entry->name);
    if (inspector.has_error()) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INSPECT", "inspect", inspector.error()));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    for (const auto &resource : resources) {
      if (resource.array_size ||
          !IsInventoryIdentifier(resource.variable_name)) {
        diagnostics.push_back(Error(
            "VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED", "inspect",
            "selected program uses a resource outside the singular-resource "
            "profile"));
        WriteSemanticExtractionFailure(request.identity, diagnostics);
        return 1;
      }
    }
    auto pairs = inspector.GetSamplerTextureUses(entry->name);
    if (inspector.has_error()) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INSPECT", "inspect", inspector.error()));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    if (resources.size() > kMaxSemanticRecords ||
        pairs.size() > kMaxSemanticSamplingPairs) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED", "inspect",
                "selected entry exceeds a semantic resource collection limit"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    entry_resources.push_back(resources);
    entry_pair_points.push_back(std::move(pairs));
  }
  std::vector<SemanticExtractionEntryResult> results;
  SemanticGraph graph;
  std::map<std::string, SemanticBindingRecord> bindings;
  std::vector<std::pair<std::string, std::string>> all_pairs;
  results.reserve(request.entry_points.size());
  for (size_t index = 0; index < request.entry_points.size(); ++index) {
    const auto &requested = request.entry_points[index];
    auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
    if (ir_result != tint::Success) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-WGSL-LOWER", "lower", ir_result.Failure().reason));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    auto &ir = ir_result.Get();
    if (index >= materialization.entries.size() ||
        materialization.entries[index].name != requested.wgsl) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-INTERNAL", "internal",
                "materializer entry ordering differs from the request"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    const auto &materialized_entry = materialization.entries[index];
    std::map<std::string, OverrideMaterializer::ScalarValue> selected_values;
    for (const auto &name : materialized_entry.exact_override_names) {
      const auto value = program_override_values.find(name);
      if (value == program_override_values.end() ||
          !selected_values.emplace(name, value->second).second) {
        diagnostics.push_back(
            Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-INTERNAL", "internal",
                  "entry override projection differs from the program union"));
        WriteSemanticExtractionFailure(request.identity, diagnostics);
        return 1;
      }
    }
    if (const auto install =
            OverrideMaterializer::InstallValues(ir, selected_values)) {
      diagnostics.push_back(Error(
          "VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-INTERNAL", "internal",
          "materialized entry values no longer match the fresh Tint IR: " +
              install->message));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    auto single_entry =
        tint::core::ir::transform::SingleEntryPoint(ir, requested.wgsl);
    if (single_entry != tint::Success) {
      diagnostics.push_back(Error("VGPU-NATIVE-TINT-SEMANTIC-LOWER", "lower",
                                  single_entry.Failure().reason));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    tint::SubstituteOverridesConfig empty_override_config;
    auto substituted = tint::core::ir::transform::SubstituteOverrides(
        ir, empty_override_config);
    if (substituted != tint::Success) {
      diagnostics.push_back(Error("VGPU-NATIVE-TINT-SEMANTIC-LOWER", "lower",
                                  substituted.Failure().reason));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    bool contains_override = false;
    for (const auto *instruction : ir.Instructions()) {
      contains_override =
          contains_override || instruction->Is<tint::core::ir::Override>();
    }
    if (contains_override) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                "semantic extraction left an active override in lowered IR"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    auto *lowered_entry = FindEntryFunction(ir, requested.wgsl);
    if (lowered_entry == nullptr) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-INTERNAL", "internal",
                "override substitution lost the selected entry"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    std::optional<std::array<uint32_t, 3>> resolved_workgroup;
    if (requested.stage == "compute") {
      const auto ir_workgroup = lowered_entry->WorkgroupSizeAsConst();
      if (!ir_workgroup || !materialized_entry.workgroup_axes) {
        diagnostics.push_back(
            Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-INTERNAL", "internal",
                  "compute workgroup evidence is incomplete"));
        WriteSemanticExtractionFailure(request.identity, diagnostics);
        return 1;
      }
      resolved_workgroup.emplace();
      for (size_t axis = 0; axis < resolved_workgroup->size(); ++axis) {
        (*resolved_workgroup)[axis] = (*ir_workgroup)[axis];
        if ((*resolved_workgroup)[axis] !=
            (*materialized_entry.workgroup_axes)[axis].resolved) {
          diagnostics.push_back(
              Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-INTERNAL", "internal",
                    "worker and materializer workgroup values differ"));
          WriteSemanticExtractionFailure(request.identity, diagnostics);
          return 1;
        }
      }
    } else if (materialized_entry.workgroup_axes ||
               lowered_entry->IsCompute()) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-INTERNAL", "internal",
                "non-compute entry has compute workgroup evidence"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
    auto semantic_interface = ExtractSemanticInterface(ir);
    if (!semantic_interface.value) {
      diagnostics.push_back(Error("VGPU-NATIVE-TINT-INTERFACE", "inspect",
                                  std::move(semantic_interface.error)));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }

    std::vector<std::string> active_bindings;
    for (const auto &resource : entry_resources[index]) {
      SemanticBindingRecord binding{.reflected = resource};
      using ResourceType = tint::inspector::ResourceBinding::ResourceType;
      if (resource.resource_type == ResourceType::kUniformBuffer ||
          resource.resource_type == ResourceType::kStorageBuffer ||
          resource.resource_type == ResourceType::kReadOnlyStorageBuffer) {
        const auto store =
            BufferStoreType(ir, resource.bind_group, resource.binding);
        const auto *store_type = store.type;
        if (!store_type || store.duplicate || !store_type->IsHostShareable() ||
            (!store_type->HasFixedFootprint() &&
             resource.resource_type == ResourceType::kUniformBuffer)) {
          diagnostics.push_back(
              Error("VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED", "inspect",
                    "selected program uses an unsupported host buffer layout"));
          WriteSemanticExtractionFailure(request.identity, diagnostics);
          return 1;
        }
        auto type = InternSemanticType(store_type, graph);
        auto layout = InternSemanticLayout(store_type, graph);
        if (!type.value || !layout.value) {
          diagnostics.push_back(Error(
              "VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED", "inspect",
              type.value ? std::move(layout.error) : std::move(type.error)));
          WriteSemanticExtractionFailure(request.identity, diagnostics);
          return 1;
        }
        binding.type = std::move(*type.value);
        binding.layout = std::move(*layout.value);
        if (resource.size != store_type->Size()) {
          diagnostics.push_back(
              Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                    "Inspector and IR disagree on minimum buffer size"));
          WriteSemanticExtractionFailure(request.identity, diagnostics);
          return 1;
        }
      } else if (resource.resource_type == ResourceType::kSampler) {
        binding.sampler_kind = InitialSamplerKind(resource);
      } else if (resource.resource_type == ResourceType::kSampledTexture ||
                 resource.resource_type == ResourceType::kMultisampledTexture) {
        binding.sample_type = InitialSampleType(resource);
      } else if (resource.resource_type ==
                     ResourceType::kWriteOnlyStorageTexture ||
                 resource.resource_type ==
                     ResourceType::kReadOnlyStorageTexture ||
                 resource.resource_type ==
                     ResourceType::kReadWriteStorageTexture) {
        binding.storage_format = StorageTextureFormat(resource.image_format);
      } else if (resource.resource_type != ResourceType::kDepthTexture &&
                 resource.resource_type !=
                     ResourceType::kDepthMultisampledTexture &&
                 resource.resource_type != ResourceType::kExternalTexture) {
        diagnostics.push_back(
            Error("VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED", "inspect",
                  "selected program uses a resource kind outside semantic v1"));
        WriteSemanticExtractionFailure(request.identity, diagnostics);
        return 1;
      }
      const auto id = BindingId(resource.bind_group, resource.binding);
      const auto [existing, inserted] = bindings.emplace(id, binding);
      if (!inserted && !SameSemanticBinding(existing->second, binding)) {
        diagnostics.push_back(
            Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                  "selected entries disagree on one resource binding"));
        WriteSemanticExtractionFailure(request.identity, diagnostics);
        return 1;
      }
      if (!inserted) {
        existing->second.reflected.size =
            std::max(existing->second.reflected.size, resource.size);
      }
      if (bindings.size() > kMaxSemanticRecords) {
        diagnostics.push_back(
            Error("VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED", "inspect",
                  "selected program exceeds the binding collection limit"));
        WriteSemanticExtractionFailure(request.identity, diagnostics);
        return 1;
      }
      active_bindings.push_back(id);
    }
    std::sort(active_bindings.begin(), active_bindings.end(),
              [&](const auto &left, const auto &right) {
                const auto &a = bindings.at(left).reflected;
                const auto &b = bindings.at(right).reflected;
                return std::tie(a.bind_group, a.binding) <
                       std::tie(b.bind_group, b.binding);
              });
    if (std::adjacent_find(active_bindings.begin(), active_bindings.end()) !=
        active_bindings.end()) {
      diagnostics.push_back(Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                                  "Inspector repeated a resource binding"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }

    auto pair_points = entry_pair_points[index];
    std::sort(pair_points.begin(), pair_points.end(),
              [](const auto &a, const auto &b) {
                return std::tie(a.texture_binding_point.group,
                                a.texture_binding_point.binding,
                                a.sampler_binding_point.group,
                                a.sampler_binding_point.binding) <
                       std::tie(b.texture_binding_point.group,
                                b.texture_binding_point.binding,
                                b.sampler_binding_point.group,
                                b.sampler_binding_point.binding);
              });
    std::vector<std::string> sampling_pairs;
    for (const auto &pair : pair_points) {
      const auto texture_id = BindingId(pair.texture_binding_point.group,
                                        pair.texture_binding_point.binding);
      const auto sampler_id = BindingId(pair.sampler_binding_point.group,
                                        pair.sampler_binding_point.binding);
      const auto texture = bindings.find(texture_id);
      const auto sampler = bindings.find(sampler_id);
      if (texture == bindings.end() || sampler == bindings.end() ||
          std::find(active_bindings.begin(), active_bindings.end(),
                    texture_id) == active_bindings.end() ||
          std::find(active_bindings.begin(), active_bindings.end(),
                    sampler_id) == active_bindings.end() ||
          !IsTextureBinding(texture->second) || !sampler->second.sampler_kind) {
        diagnostics.push_back(
            Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                  "Inspector returned an incoherent sampler-texture pair"));
        WriteSemanticExtractionFailure(request.identity, diagnostics);
        return 1;
      }
      const auto mode = sampler->second.sampler_kind == "comparison"
                            ? "comparison"
                            : "filtering";
      sampling_pairs.push_back("{\"texture\":" + JsonString(texture_id) +
                               ",\"sampler\":" + JsonString(sampler_id) +
                               ",\"mode\":" + JsonString(mode) + "}");
      all_pairs.emplace_back(texture_id, sampler_id);
      if (all_pairs.size() >
          request.entry_points.size() * kMaxSemanticSamplingPairs) {
        diagnostics.push_back(Error(
            "VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED", "inspect",
            "selected program exceeds the sampling-pair collection limit"));
        WriteSemanticExtractionFailure(request.identity, diagnostics);
        return 1;
      }
    }
    sampling_pairs.erase(
        std::unique(sampling_pairs.begin(), sampling_pairs.end()),
        sampling_pairs.end());
    results.push_back(SemanticExtractionEntryResult{
        .entry_point = requested,
        .semantic_interface = std::move(*semantic_interface.value),
        .bindings = std::move(active_bindings),
        .sampling_pairs = std::move(sampling_pairs),
        .overrides = materialized_entry.exact_override_names,
        .workgroup_size = resolved_workgroup,
    });
  }

  ResolveUnknownBindingKinds(bindings, all_pairs);
  if (!ResolvedPairsAreCoherent(bindings, all_pairs)) {
    diagnostics.push_back(
        Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
              "resolved sampler and texture classes are incoherent"));
    WriteSemanticExtractionFailure(request.identity, diagnostics);
    return 1;
  }
  for (const auto &[id, binding] : bindings) {
    if (!SemanticBindingJson(binding)) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-SEMANTIC-RESOURCE-UNSUPPORTED", "inspect",
                "selected program left an unsupported resource shape"));
      WriteSemanticExtractionFailure(request.identity, diagnostics);
      return 1;
    }
  }
  if (const auto error = PreflightSemanticOverrides(materialization, results)) {
    diagnostics.push_back(Error("VGPU-NATIVE-TINT-SEMANTIC-OVERRIDE-INTERNAL",
                                "internal", *error));
    WriteSemanticExtractionFailure(request.identity, diagnostics);
    return 1;
  }
  WriteSemanticExtractionSuccess(request, diagnostics, results, bindings, graph,
                                 materialization);
  return 0;
}

} // namespace

int main(int argc, char **) {
  constexpr int kExitUsage = 64;
  constexpr int kExitFraming = 65;
  constexpr int kExitInternal = 70;
  constexpr int kExitIo = 74;
  if (argc != 1) {
    std::cerr << "vgpu-tint-compiler: this worker accepts no arguments\n";
    return kExitUsage;
  }
#ifdef _WIN32
  if (_setmode(_fileno(stdin), _O_BINARY) == -1 ||
      _setmode(_fileno(stdout), _O_BINARY) == -1) {
    std::cerr << "vgpu-tint-compiler: could not configure binary pipes\n";
    return kExitIo;
  }
#endif

  vgpu::native::DecodedRequest decoded;
  try {
    decoded = vgpu::native::ReadRequest(std::cin);
  } catch (const std::exception &) {
    std::cerr << "vgpu-tint-compiler: request decoder raised an exception\n";
    return kExitInternal;
  } catch (...) {
    std::cerr << "vgpu-tint-compiler: request decoder failed\n";
    return kExitInternal;
  }
  if (!decoded.value) {
    if (decoded.failure == vgpu::native::RequestFailureKind::kProtocol) {
      const auto diagnostics = std::vector{
          Error("VGPU-NATIVE-TINT-PROTOCOL", "protocol", decoded.error)};
      if (decoded.operation ==
              vgpu::native::RequestOperation::kEntryInventory &&
          decoded.request_identity) {
        WriteEntryInventoryFailure(*decoded.request_identity, diagnostics);
      } else if (decoded.operation ==
                     vgpu::native::RequestOperation::kSemanticExtraction &&
                 decoded.request_identity) {
        WriteSemanticExtractionFailure(*decoded.request_identity, diagnostics);
      } else {
        WriteFailure(diagnostics);
      }
      return g_output_succeeded ? 0 : kExitIo;
    }
    std::cerr << (decoded.failure == vgpu::native::RequestFailureKind::kIo
                      ? "vgpu-tint-compiler: stdin read failed\n"
                      : "vgpu-tint-compiler: invalid request framing\n");
    return decoded.failure == vgpu::native::RequestFailureKind::kIo
               ? kExitIo
               : kExitFraming;
  }

  tint::Initialize();
  const auto write_internal_failure = [&](std::string message) {
    const auto diagnostics = std::vector{
        Error("VGPU-NATIVE-TINT-INTERNAL", "internal", std::move(message))};
    if (std::holds_alternative<EntryInventoryRequest>(*decoded.value)) {
      WriteEntryInventoryFailure(
          std::get<EntryInventoryRequest>(*decoded.value).identity,
          diagnostics);
    } else if (std::holds_alternative<SemanticExtractionRequest>(
                   *decoded.value)) {
      WriteSemanticExtractionFailure(
          std::get<SemanticExtractionRequest>(*decoded.value).identity,
          diagnostics);
    } else {
      WriteFailure(diagnostics);
    }
  };
  try {
    std::visit([](const auto &request) { Run(request); }, *decoded.value);
  } catch (const std::exception &) {
    write_internal_failure("compiler raised an internal exception");
  } catch (...) {
    write_internal_failure("compiler failed with an unknown exception");
  }
  tint::Shutdown();
  return g_output_succeeded ? 0 : kExitIo;
}
