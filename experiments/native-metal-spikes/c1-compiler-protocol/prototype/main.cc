// Feasibility prototype for the vgpu-owned Tint compiler protocol.
//
// JSON decoding intentionally lives in the Node adapter for this spike. This
// executable accepts a typed, single-entry-point request:
//
//   wrapper --source <input.wgsl> --source-name <virtual-path> \
//     --stage <vertex|fragment|compute> --entry-point <wgsl-name> \
//     --emitted-name <metal-name> --mapping <mapping.txt> \
//     [--feature
//     <f16|uniform_buffer_standard_layout|unrestricted_pointer_parameters|sized_binding_array>]
//     \
//     [--override <name> <bool|i32|u32|f16|f32> <payload>]...
//
// Overrides are exhaustive for the selected entry point. Boolean payloads are
// true/false, integer payloads are decimal, and f16/f32 payloads are lowercase
// IEEE 754 bits (four/eight hexadecimal digits). NaN and infinity are rejected.
//
// Each non-comment mapping line is:
//
//   <group> <binding> <buffer|texture|sampler> <buffer|texture|sampler>
//   <metal-index> <count>
//
// The two string fields are the vgpu resource class and component. This v1
// prototype only accepts direct, single-component resources, so they must
// agree. The exact Tint binding kind (uniform, storage, sampled texture,
// storage texture, or sampler) is derived from Inspector, never supplied by
// the adapter.
//
// The executable writes exactly one JSON value to stdout. Exit 0 is a
// successful translation, exit 1 is a valid request with a negative compiler
// result, and exit 2 is an invalid invocation or typed request. Controlled
// failures are reported in JSON, not stderr. These are prototype-worker exit
// codes, not the final JSON transport contract: the Node adapter treats any
// trustworthy decoded response as handled and reads `ok` for the outcome.
//
// This prototype owns the Metal ABI instead of accepting translator-selected
// internals. External buffer intervals are restricted to 0..<30. Tint receives
// one shared immediate-data binding at buffer(30), with the storage-buffer-size
// table starting at byte offset 4 and the ordinary non-constant-zero word at
// byte offset 0. The response reports an effective internal binding and
// storage-buffer-size region only when Tint's raised entry interface / writer
// output uses them.

#include <algorithm>
#include <bit>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <exception>
#include <fstream>
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
#include "src/tint/lang/core/ir/referenced_module_vars.h"
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

namespace {

constexpr uint32_t kExternalBufferCeiling = 30;
constexpr uint32_t kImmediateDataIndex = 30;
constexpr uint32_t kStorageBufferSizesOffset = 4;
constexpr uint32_t kNonConstantZeroOffset = 0;
constexpr size_t kDiagnosticMessageMaxBytes = 16384;
constexpr std::string_view kContractId = "vgpu-native-tint-compiler/v1";
constexpr std::string_view kTintRevision =
    "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";

static_assert(sizeof(float) == sizeof(uint32_t));
static_assert(std::numeric_limits<float>::is_iec559);

struct Mapping {
  std::string kind;
  tint::BindingPoint source;
  std::string resource_class;
  std::string component;
  uint32_t index;
  uint32_t count;
};

struct OverrideValue {
  std::string type;
  double value;
};

struct Arguments {
  std::string source_path;
  std::string source_name;
  std::string stage;
  std::string entry_point;
  std::string emitted_name;
  std::string mapping_path;
  std::set<std::string> features;
  std::map<std::string, OverrideValue> overrides;
};

struct ParsedArguments {
  std::optional<Arguments> value;
  std::string error;
};

struct ParsedMappings {
  std::optional<std::vector<Mapping>> value;
  std::string error;
};

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
  std::cout << output.str();
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

std::optional<uint64_t> ParseUnsignedInteger(std::string_view value,
                                             int base = 10) {
  if (value.empty()) {
    return std::nullopt;
  }
  uint64_t parsed = 0;
  const auto result =
      std::from_chars(value.data(), value.data() + value.size(), parsed, base);
  if (result.ec != std::errc{} || result.ptr != value.data() + value.size()) {
    return std::nullopt;
  }
  return parsed;
}

std::optional<int64_t> ParseSignedInteger(std::string_view value) {
  if (value.empty()) {
    return std::nullopt;
  }
  int64_t parsed = 0;
  const auto result =
      std::from_chars(value.data(), value.data() + value.size(), parsed, 10);
  if (result.ec != std::errc{} || result.ptr != value.data() + value.size()) {
    return std::nullopt;
  }
  return parsed;
}

bool IsLowerHex(std::string_view value, size_t length) {
  return value.size() == length &&
         std::all_of(value.begin(), value.end(),
                     [](const unsigned char character) {
                       return (character >= '0' && character <= '9') ||
                              (character >= 'a' && character <= 'f');
                     });
}

std::optional<OverrideValue> ParseOverrideValue(std::string type,
                                                std::string_view payload) {
  if (type == "bool") {
    if (payload == "true") {
      return OverrideValue{.type = std::move(type), .value = 1.0};
    }
    if (payload == "false") {
      return OverrideValue{.type = std::move(type), .value = 0.0};
    }
    return std::nullopt;
  }
  if (type == "i32") {
    const auto parsed = ParseSignedInteger(payload);
    if (!parsed || *parsed < std::numeric_limits<int32_t>::min() ||
        *parsed > std::numeric_limits<int32_t>::max()) {
      return std::nullopt;
    }
    return OverrideValue{.type = std::move(type),
                         .value = static_cast<double>(*parsed)};
  }
  if (type == "u32") {
    const auto parsed = ParseUnsignedInteger(payload);
    if (!parsed || *parsed > std::numeric_limits<uint32_t>::max()) {
      return std::nullopt;
    }
    return OverrideValue{.type = std::move(type),
                         .value = static_cast<double>(*parsed)};
  }
  if (type == "f32") {
    if (!IsLowerHex(payload, 8)) {
      return std::nullopt;
    }
    const auto parsed = ParseUnsignedInteger(payload, 16);
    if (!parsed || *parsed > std::numeric_limits<uint32_t>::max()) {
      return std::nullopt;
    }
    const float value = std::bit_cast<float>(static_cast<uint32_t>(*parsed));
    if (!std::isfinite(value)) {
      return std::nullopt;
    }
    return OverrideValue{.type = std::move(type),
                         .value = static_cast<double>(value)};
  }
  if (type == "f16") {
    if (!IsLowerHex(payload, 4)) {
      return std::nullopt;
    }
    const auto parsed = ParseUnsignedInteger(payload, 16);
    if (!parsed || *parsed > std::numeric_limits<uint16_t>::max()) {
      return std::nullopt;
    }
    const uint16_t bits = static_cast<uint16_t>(*parsed);
    const uint16_t exponent = (bits >> 10) & 0x1f;
    const uint16_t fraction = bits & 0x03ff;
    if (exponent == 0x1f) {
      return std::nullopt;
    }
    double value = exponent == 0
                       ? std::ldexp(static_cast<double>(fraction), -24)
                       : std::ldexp(static_cast<double>(1024 + fraction),
                                    static_cast<int>(exponent) - 25);
    if ((bits & 0x8000) != 0) {
      value = -value;
    }
    return OverrideValue{.type = std::move(type), .value = value};
  }
  return std::nullopt;
}

bool SetOnce(std::string &destination, std::string value) {
  if (!destination.empty() || value.empty()) {
    return false;
  }
  destination = std::move(value);
  return true;
}

bool IsVgpuEmittedName(std::string_view value) {
  constexpr std::string_view kPrefix = "vgpu_";
  if (!value.starts_with(kPrefix) || value.size() == kPrefix.size() ||
      value.size() > 256) {
    return false;
  }
  const auto suffix = value.substr(kPrefix.size());
  return std::all_of(
      suffix.begin(), suffix.end(), [](const unsigned char character) {
        return (character >= 'a' && character <= 'z') ||
               (character >= 'A' && character <= 'Z') ||
               (character >= '0' && character <= '9') || character == '_';
      });
}

ParsedArguments ParseArguments(int argc, char **argv) {
  Arguments arguments;
  for (int index = 1; index < argc; ++index) {
    const std::string_view flag = argv[index];
    const auto take_one = [&](std::string &destination) -> bool {
      if (index + 1 >= argc) {
        return false;
      }
      return SetOnce(destination, argv[++index]);
    };
    if (flag == "--source") {
      if (!take_one(arguments.source_path)) {
        return {
            .error =
                "--source requires one non-empty value and may appear once"};
      }
    } else if (flag == "--source-name") {
      if (!take_one(arguments.source_name)) {
        return {.error = "--source-name requires one non-empty value and may "
                         "appear once"};
      }
    } else if (flag == "--stage") {
      if (!take_one(arguments.stage)) {
        return {.error =
                    "--stage requires one non-empty value and may appear once"};
      }
    } else if (flag == "--entry-point") {
      if (!take_one(arguments.entry_point)) {
        return {.error = "--entry-point requires one non-empty value and may "
                         "appear once"};
      }
    } else if (flag == "--emitted-name") {
      if (!take_one(arguments.emitted_name)) {
        return {.error = "--emitted-name requires one non-empty value and may "
                         "appear once"};
      }
    } else if (flag == "--mapping") {
      if (!take_one(arguments.mapping_path)) {
        return {
            .error =
                "--mapping requires one non-empty value and may appear once"};
      }
    } else if (flag == "--feature") {
      if (index + 1 >= argc) {
        return {.error = "--feature requires one value"};
      }
      std::string feature = argv[++index];
      if (feature.empty() ||
          !arguments.features.insert(std::move(feature)).second) {
        return {.error = "language features must be non-empty and unique"};
      }
    } else if (flag == "--override") {
      if (index + 3 >= argc) {
        return {.error =
                    "--override requires a name, scalar type, and payload"};
      }
      std::string name = argv[++index];
      std::string type = argv[++index];
      const auto value = ParseOverrideValue(std::move(type), argv[++index]);
      if (name.empty() || !value ||
          !arguments.overrides.emplace(std::move(name), *value).second) {
        return {.error = "overrides must have unique non-empty names, matching "
                         "scalar types, and valid finite payloads"};
      }
    } else {
      return {.error = "unknown argument"};
    }
  }

  if (arguments.source_path.empty() || arguments.source_name.empty() ||
      arguments.stage.empty() || arguments.entry_point.empty() ||
      arguments.emitted_name.empty() || arguments.mapping_path.empty()) {
    return {.error = "missing required compiler argument"};
  }
  if (arguments.stage != "vertex" && arguments.stage != "fragment" &&
      arguments.stage != "compute") {
    return {.error = "--stage must be vertex, fragment, or compute"};
  }
  if (!IsVgpuEmittedName(arguments.emitted_name)) {
    return {.error =
                "--emitted-name must use the reserved vgpu_ identifier domain"};
  }
  static const std::set<std::string> kAllowedFeatures{
      "f16",
      "sized_binding_array",
      "uniform_buffer_standard_layout",
      "unrestricted_pointer_parameters",
  };
  for (const auto &feature : arguments.features) {
    if (!kAllowedFeatures.contains(feature)) {
      return {.error = "unsupported language feature"};
    }
  }
  return {.value = std::move(arguments)};
}

std::optional<std::string> ReadFile(const std::string &path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) {
    return std::nullopt;
  }
  std::ostringstream contents;
  contents << stream.rdbuf();
  if (!stream.good() && !stream.eof()) {
    return std::nullopt;
  }
  return contents.str();
}

ParsedMappings ReadMappings(const std::string &path) {
  std::ifstream stream(path);
  if (!stream) {
    return {.error = "could not read the binding mapping"};
  }
  std::vector<Mapping> mappings;
  std::string line;
  size_t line_number = 0;
  while (std::getline(stream, line)) {
    ++line_number;
    const auto first = line.find_first_not_of(" \t\r");
    if (first == std::string::npos || line[first] == '#') {
      continue;
    }
    std::istringstream fields(line);
    uint64_t group = 0;
    uint64_t binding = 0;
    std::string resource_class;
    std::string component;
    uint64_t index = 0;
    uint64_t count = 0;
    if (!(fields >> group >> binding >> resource_class >> component >> index >>
          count) ||
        (fields >> std::ws && !fields.eof()) ||
        group > std::numeric_limits<uint32_t>::max() ||
        binding > std::numeric_limits<uint32_t>::max() ||
        index > std::numeric_limits<uint32_t>::max() || count == 0 ||
        count > std::numeric_limits<uint32_t>::max()) {
      return {.error = "invalid binding mapping at line " +
                       std::to_string(line_number)};
    }
    mappings.push_back(Mapping{
        .kind = {},
        .source = tint::BindingPoint{.group = static_cast<uint32_t>(group),
                                     .binding = static_cast<uint32_t>(binding)},
        .resource_class = std::move(resource_class),
        .component = std::move(component),
        .index = static_cast<uint32_t>(index),
        .count = static_cast<uint32_t>(count),
    });
  }
  if (!stream.eof()) {
    return {.error = "could not finish reading the binding mapping"};
  }
  return {.value = std::move(mappings)};
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

std::vector<Diagnostic>
ConvertDiagnostics(const tint::diag::List &source,
                   const tint::Source::File &authored_file,
                   const std::string &virtual_path) {
  std::vector<Diagnostic> diagnostics;
  diagnostics.reserve(source.size());
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
    diagnostics.push_back(Diagnostic{
        .code = "VGPU-NATIVE-WGSL-INVALID",
        .severity = SeverityName(item.severity),
        .phase = "wgsl",
        .message = BoundedDiagnosticMessage(item.message.Plain()),
        .location = std::move(location),
    });
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
  std::cout << output.str();
}

int Run(const Arguments &arguments) {
  const auto source_text = ReadFile(arguments.source_path);
  if (!source_text) {
    WriteFailure({Error("VGPU-NATIVE-TINT-PROTOCOL", "protocol",
                        "could not read WGSL input")});
    return 2;
  }
  const auto parsed_mappings = ReadMappings(arguments.mapping_path);
  if (!parsed_mappings.value) {
    WriteFailure({Error("VGPU-NATIVE-TINT-PROTOCOL", "protocol",
                        parsed_mappings.error)});
    return 2;
  }
  auto mappings = std::move(*parsed_mappings.value);
  if (const auto mapping_error = ValidateRequestedMappings(mappings)) {
    WriteFailure(
        {Error("VGPU-NATIVE-TINT-PROTOCOL", "protocol", *mapping_error)});
    return 2;
  }

  tint::Source::File source_file(arguments.source_name, *source_text);
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
  writer_options.substitute_overrides_config = std::move(override_config);

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

int main(int argc, char **argv) {
  const auto parsed = ParseArguments(argc, argv);
  if (!parsed.value) {
    WriteFailure(
        {Error("VGPU-NATIVE-TINT-PROTOCOL", "protocol", parsed.error)});
    return 2;
  }

  tint::Initialize();
  int result = 1;
  try {
    result = Run(*parsed.value);
  } catch (const std::exception &) {
    WriteFailure({Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                        "compiler raised an internal exception")});
    result = 1;
  } catch (...) {
    WriteFailure({Error("VGPU-NATIVE-TINT-INTERNAL", "internal",
                        "compiler failed with an unknown exception")});
    result = 1;
  }
  tint::Shutdown();
  return result;
}
