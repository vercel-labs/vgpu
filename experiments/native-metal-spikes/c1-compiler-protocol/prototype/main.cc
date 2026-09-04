// Feasibility prototype for the vgpu-owned Tint compiler protocol.
//
// This one-shot worker reads exactly one UTF-8 JSON request from stdin through
// EOF and writes exactly one JSON response to stdout. A decoded request always
// exits zero, including protocol and compiler failures; framing, I/O, or a
// process failure exits nonzero and makes stdout untrustworthy.
//
// This prototype owns the Metal ABI instead of accepting translator-selected
// internals. External buffer intervals are restricted to 0..<30. Tint receives
// one shared immediate-data binding at buffer(30), with the storage-buffer-size
// table starting at byte offset 4 and the ordinary non-constant-zero word at
// byte offset 0. The response reports an effective internal binding and
// storage-buffer-size region only when Tint's raised entry interface / writer
// output uses them.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <exception>
#include <iostream>
#include <limits>
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
#include "src/tint/lang/core/ir/builder.h"
#include "src/tint/lang/core/ir/override.h"
#include "src/tint/lang/core/ir/referenced_module_vars.h"
#include "src/tint/lang/core/ir/transform/single_entry_point.h"
#include "src/tint/lang/core/ir/transform/substitute_overrides.h"
#include "src/tint/lang/core/type/array.h"
#include "src/tint/lang/core/type/binding_array.h"
#include "src/tint/lang/core/type/memory_view.h"
#include "src/tint/lang/core/type/pointer.h"
#include "src/tint/lang/core/type/sampler.h"
#include "src/tint/lang/core/type/texture.h"
#include "src/tint/lang/msl/writer/writer.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"
#include "src/tint/utils/diagnostic/diagnostic.h"

#include "json-codec.h"
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
constexpr std::string_view kContractId = "vgpu-native-tint-compiler/v1";
constexpr std::string_view kTintRevision =
    "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";

static_assert(sizeof(float) == sizeof(uint32_t));
static_assert(std::numeric_limits<float>::is_iec559);

using Arguments = vgpu::native::CompilerRequest;
using Mapping = vgpu::native::Mapping;

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

Diagnostic Error(std::string code, std::string phase, std::string message) {
  return Diagnostic{
      .code = std::move(code),
      .severity = "error",
      .phase = std::move(phase),
      .message = BoundedDiagnosticMessage(std::move(message)),
      .location = std::nullopt,
  };
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

const char *OverrideTypeName(tint::inspector::Override::Type type) {
  using Type = tint::inspector::Override::Type;
  switch (type) {
  case Type::kBool:
    return "bool";
  case Type::kInt32:
    return "i32";
  case Type::kUint32:
    return "u32";
  case Type::kFloat16:
    return "f16";
  case Type::kFloat32:
    return "f32";
  }
  return "unknown";
}

tint::core::ir::Constant *
MakeOverrideConstant(tint::core::ir::Builder &builder,
                     const tint::core::type::Type *type, double value) {
  // The decoder widens finite f32 values to double and reconstructs finite f16
  // values as exact binary rationals. Both conversions are lossless (including
  // subnormals), so narrowing to the reflected type recovers the request bits;
  // Tint's f16 quantizer also preserves the sign of zero.
  if (type->Is<tint::core::type::Bool>()) {
    return builder.Constant(value != 0.0);
  }
  if (type->Is<tint::core::type::I32>()) {
    return builder.Constant(tint::core::i32{static_cast<int32_t>(value)});
  }
  if (type->Is<tint::core::type::U32>()) {
    return builder.Constant(tint::core::u32{static_cast<uint32_t>(value)});
  }
  if (type->Is<tint::core::type::F16>()) {
    const tint::core::f16 narrowed(value);
    const float roundtrip = static_cast<float>(narrowed);
    if (static_cast<double>(roundtrip) != value ||
        std::signbit(roundtrip) != std::signbit(value)) {
      return nullptr;
    }
    return builder.Constant(narrowed);
  }
  if (type->Is<tint::core::type::F32>()) {
    const float narrowed = static_cast<float>(value);
    if (static_cast<double>(narrowed) != value ||
        std::signbit(narrowed) != std::signbit(value)) {
      return nullptr;
    }
    return builder.Constant(tint::core::f32{narrowed});
  }
  return nullptr;
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

void WriteSlot(std::ostream &output, std::string_view resource_class,
               std::string_view component, uint32_t index, uint32_t count) {
  output << "{\"mode\": \"direct\", \"resourceClass\": "
         << JsonString(resource_class)
         << ", \"component\": " << JsonString(component)
         << ", \"index\": " << index << ", \"count\": " << count << '}';
}

void WriteSuccess(const Arguments &arguments, std::vector<Mapping> mappings,
                  const std::vector<Diagnostic> &diagnostics,
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
  for (const auto &feature : arguments.features) {
    if (feature == "f16") {
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

  tint::SubstituteOverridesConfig override_config;
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
    if (value->second.type != OverrideTypeName(reflected_override.type)) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INSPECT", "inspect",
                "request override type differs from Tint reflection"));
      WriteFailure(diagnostics);
      return 1;
    }
    if (!override_config.map.emplace(reflected_override.id, value->second.value)
             .second) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                "Tint reflected a duplicate selected-entry override"));
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

  // Replace the materialized exact-static values before pruning. Their
  // declared initializers are not evaluated, and replacing them here lets
  // SingleEntryPoint remove both inactive overrides and initializer-only
  // dependencies before constant evaluation.
  tint::core::ir::Builder override_builder(ir);
  std::set<uint16_t> materialized_override_ids;
  for (auto *instruction : *ir.root_block) {
    auto *item = instruction->As<tint::core::ir::Override>();
    if (item == nullptr || !item->OverrideId()) {
      continue;
    }
    const auto selection = override_config.map.find(*item->OverrideId());
    if (selection == override_config.map.end()) {
      continue;
    }
    auto *constant = MakeOverrideConstant(
        override_builder, item->Result()->Type(), selection->second);
    if (constant == nullptr) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                "exact-static override could not be represented exactly in "
                "its IR scalar type"));
      WriteFailure(diagnostics);
      return 1;
    }
    item->SetInitializer(constant);
    if (!materialized_override_ids.insert(item->OverrideId()->value).second) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                "Tint IR contains a duplicate exact-static override ID"));
      WriteFailure(diagnostics);
      return 1;
    }
  }
  for (const auto &[id, value] : override_config.map) {
    static_cast<void>(value);
    if (!materialized_override_ids.contains(id.value)) {
      diagnostics.push_back(
          Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                "exact-static override could not be materialized in Tint IR"));
      WriteFailure(diagnostics);
      return 1;
    }
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

  WriteSuccess(arguments, mappings, diagnostics, generated.Get(),
               used_immediate);
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
      WriteFailure(
          {Error("VGPU-NATIVE-TINT-PROTOCOL", "protocol", decoded.error)});
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
  try {
    Run(*decoded.value);
  } catch (const std::exception &) {
    WriteFailure({Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                        "compiler raised an internal exception")});
  } catch (...) {
    WriteFailure({Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                        "compiler failed with an unknown exception")});
  }
  tint::Shutdown();
  return g_output_succeeded ? 0 : kExitIo;
}
