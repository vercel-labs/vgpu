// Standalone adapter for the worker-adjacent exact-static override
// materializer.
//
// Usage:
//   prototype --source <path> --source-name <virtual-path> --entry-point <name>
//     [--feature f16]
//     [--identifier <wgsl-override-identifier> <bool|number> <payload>]...
//
// The process prints exactly one JSON result. This typed CLI is intentionally
// local to the spike; it is not a proposed worker transport.

#include <CommonCrypto/CommonDigest.h>

#include <array>
#include <charconv>
#include <cstdint>
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
#include <variant>
#include <vector>

#include "override-materializer.h"
#include "src/tint/api/tint.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"

namespace {

constexpr std::string_view kContractId =
    "vgpu-native-override-defaults-spike/v1";
constexpr std::string_view kTintRevision =
    "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca";

using Configuration = vgpu::native::overrides::Configuration;
using DefaultStatus = vgpu::native::overrides::DefaultStatus;
using EngineDiagnostic = vgpu::native::overrides::Diagnostic;
using EntryResult = vgpu::native::overrides::EntryResult;
using F16Bits = vgpu::native::overrides::F16Bits;
using F32Bits = vgpu::native::overrides::F32Bits;
using Materialization = vgpu::native::overrides::Materialization;
using OverrideRecord = vgpu::native::overrides::OverrideRecord;
using PipelineStage = vgpu::native::overrides::PipelineStage;
using ScalarValue = vgpu::native::overrides::ScalarValue;
using SelectedEntry = vgpu::native::overrides::SelectedEntry;

struct Diagnostic {
  std::string code;
  std::string phase;
  std::string message;
};

struct Arguments {
  std::string source_path;
  std::string source_name;
  std::string entry_point;
  bool enable_f16 = false;
  std::vector<Configuration> config;
};

struct ParseArgumentsResult {
  std::optional<Arguments> arguments;
  std::optional<Diagnostic> error;
  int exit_code = 2;
};

Diagnostic Error(std::string code, std::string phase, std::string message) {
  return Diagnostic{.code = std::move(code),
                    .phase = std::move(phase),
                    .message = std::move(message)};
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
    if (flag == "--identifier") {
      if (index + 3 >= argc) {
        return {.error = Error(
                    "VGPU-C1-OVERRIDE-REQUEST", "request",
                    "--identifier requires a key, value kind, and payload")};
      }
      Configuration config;
      config.identifier = argv[++index];
      const std::string value_kind = argv[++index];
      const std::string payload = argv[++index];
      if (config.identifier.empty()) {
        return {.error = Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                               "override config keys cannot be empty")};
      }
      if (value_kind == "bool") {
        if (payload == "true") {
          config.value = true;
        } else if (payload == "false") {
          config.value = false;
        } else {
          return {.error = Error(
                      "VGPU-C1-OVERRIDE-REQUEST", "request",
                      "override values use bool or number payload kinds")};
        }
      } else if (value_kind == "number") {
        const auto number = ParseNumber(payload);
        if (!number) {
          return {.error = Error(
                      "VGPU-C1-OVERRIDE-REQUEST", "request",
                      "override values use bool or number payload kinds")};
        }
        config.value = *number;
      } else if (value_kind == "string") {
        return {.error = Error("VGPU-C1-OVERRIDE-WRONG-TYPE", "config",
                               "override values must be booleans or numbers"),
                .exit_code = 1};
      } else {
        return {.error =
                    Error("VGPU-C1-OVERRIDE-REQUEST", "request",
                          "override values use bool or number payload kinds")};
      }
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

void WriteScalarValue(std::ostream &output, const ScalarValue &value) {
  output << "{\"type\": "
         << JsonString(vgpu::native::overrides::ScalarTypeName(
                vgpu::native::overrides::ScalarTypeOf(value)));
  if (const auto *boolean = std::get_if<bool>(&value)) {
    output << ", \"value\": " << (*boolean ? "true" : "false");
  } else if (const auto *i32 = std::get_if<int32_t>(&value)) {
    output << ", \"value\": " << *i32;
  } else if (const auto *u32 = std::get_if<uint32_t>(&value)) {
    output << ", \"value\": " << *u32;
  } else if (const auto *f16 = std::get_if<F16Bits>(&value)) {
    output << ", \"bits\": \"" << std::hex << std::setw(4) << std::setfill('0')
           << f16->bits << std::dec << '"';
  } else {
    output << ", \"bits\": \"" << std::hex << std::setw(8) << std::setfill('0')
           << std::get<F32Bits>(value).bits << std::dec << '"';
  }
  output << '}';
}

struct ReflectedMetadata {
  uint16_t id = 0;
  bool explicit_id = false;
  bool has_initializer = false;
};

void WriteOverrides(
    std::ostream &output, const std::vector<std::string> &names,
    const std::map<std::string, const OverrideRecord *> &records,
    const std::map<std::string, ReflectedMetadata> &reflection) {
  output << '[';
  if (!names.empty()) {
    output << '\n';
  }
  for (size_t index = 0; index < names.size(); ++index) {
    const auto &name = names[index];
    const auto &item = *records.at(name);
    const auto &reflected = reflection.at(name);
    output << "    {\"name\": " << JsonString(name)
           << ", \"id\": {\"value\": " << reflected.id << ", \"kind\": "
           << JsonString(reflected.explicit_id ? "explicit" : "auto")
           << "}, \"type\": "
           << JsonString(vgpu::native::overrides::ScalarTypeName(
                  vgpu::native::overrides::ScalarTypeOf(item.selected)))
           << ", \"initializer\": "
           << JsonString(reflected.has_initializer ? "present" : "absent")
           << ", \"defaultEvaluation\": {\"status\": ";
    switch (item.default_result.status) {
    case DefaultStatus::kAbsent:
      output << JsonString("absent");
      break;
    case DefaultStatus::kUnavailable:
      output << JsonString("unavailable")
             << ", \"reason\": " << JsonString("requires-configuration");
      break;
    case DefaultStatus::kValue:
      output << JsonString("value") << ", \"value\": ";
      WriteScalarValue(output, *item.default_result.value);
      break;
    }
    output << "}, \"selected\": ";
    WriteScalarValue(output, item.selected);
    output << '}' << (index + 1 == names.size() ? "\n" : ",\n");
  }
  output << "  ]";
}

void WriteSuccess(const Arguments &arguments, std::string_view source_sha256,
                  const Materialization &materialization,
                  const std::map<std::string, ReflectedMetadata> &reflection) {
  const EntryResult &entry = materialization.entries.front();
  std::map<std::string, const OverrideRecord *> records;
  for (const auto &item : materialization.overrides) {
    records.emplace(item.name, &item);
  }
  std::ostringstream output;
  output << "{\n"
         << "  \"schemaVersion\": 1,\n"
         << "  \"contractId\": " << JsonString(kContractId) << ",\n"
         << "  \"ok\": true,\n"
         << "  \"upstreamRevision\": " << JsonString(kTintRevision) << ",\n"
         << "  \"sourceName\": " << JsonString(arguments.source_name) << ",\n"
         << "  \"sourceSha256\": " << JsonString(source_sha256) << ",\n"
         << "  \"entryPoint\": {\"name\": " << JsonString(entry.name)
         << ", \"stage\": "
         << JsonString(vgpu::native::overrides::PipelineStageName(entry.stage))
         << "},\n"
         << "  \"staticOverrides\": ";
  WriteOverrides(output, entry.exact_override_names, records, reflection);
  output << ",\n  \"overrides\": ";
  WriteOverrides(output, entry.effective_override_names, records, reflection);
  output << ",\n"
         << "  \"verification\": {\"singleEntryPoint\": true, "
            "\"substituteOverrides\": true, "
            "\"fullActiveMapAccepted\": true, "
            "\"exactStaticOverrideCount\": "
         << entry.exact_override_names.size() << ", "
         << "\"verifiedOverrideCount\": "
         << entry.effective_override_names.size();
  if (entry.workgroup_axes) {
    output << ", \"workgroupSize\": [" << (*entry.workgroup_axes)[0].resolved
           << ", " << (*entry.workgroup_axes)[1].resolved << ", "
           << (*entry.workgroup_axes)[2].resolved
           << "], \"workgroupSizeAxes\": [";
    for (size_t axis_index = 0; axis_index < entry.workgroup_axes->size();
         ++axis_index) {
      const auto &axis = (*entry.workgroup_axes)[axis_index];
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
      if (axis_index + 1 != entry.workgroup_axes->size()) {
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
    return parsed_arguments.exit_code;
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
  const auto reflected_entry = inspector.GetEntryPoint(arguments.entry_point);
  if (inspector.has_error()) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-ENTRY", "inspect", inspector.error()));
    return 1;
  }
  const auto stage = MaterializerStage(reflected_entry.stage);
  if (!stage) {
    WriteFailure(Error("VGPU-C1-OVERRIDE-INTERNAL", "internal",
                       "Inspector returned an unsupported pipeline stage"));
    return 1;
  }
  auto result = vgpu::native::overrides::Materialize(
      program, {SelectedEntry{.name = arguments.entry_point, .stage = *stage}},
      arguments.config);
  if (const auto *diagnostic = std::get_if<EngineDiagnostic>(&result)) {
    WriteFailure(Diagnostic{
        .code = vgpu::native::overrides::DiagnosticCodeName(diagnostic->code),
        .phase =
            vgpu::native::overrides::DiagnosticPhaseName(diagnostic->phase),
        .message = diagnostic->message,
    });
    return 1;
  }
  std::map<std::string, ReflectedMetadata> reflection;
  for (const auto &item : inspector.Overrides()) {
    reflection.emplace(
        item.name, ReflectedMetadata{.id = item.id.value,
                                     .explicit_id = item.is_id_specified,
                                     .has_initializer = item.is_initialized});
  }
  WriteSuccess(arguments, *source_sha256, std::get<Materialization>(result),
               reflection);
  return 0;
}

} // namespace

int main(int argc, char **argv) { return Run(argc, argv); }
