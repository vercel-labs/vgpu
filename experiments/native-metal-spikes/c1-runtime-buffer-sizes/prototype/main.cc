// Feasibility prototype only. This is not a public compiler protocol.
//
// The wrapper consumes a vgpu-owned direct Metal buffer map. Every active
// storage binding maps its runtime-size-table word to that same Metal buffer
// index. It never calls Tint's GenerateBindings.

#include <algorithm>
#include <cstdint>
#include <fstream>
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
#include "src/tint/lang/core/ir/referenced_module_vars.h"
#include "src/tint/lang/core/type/memory_view.h"
#include "src/tint/lang/core/type/pointer.h"
#include "src/tint/lang/msl/writer/writer.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"

namespace {

struct Mapping {
  std::string kind;
  tint::BindingPoint source;
  uint32_t metal_index;
};

struct Arguments {
  std::string input_path;
  std::string entry_point;
  std::string emitted_name;
  std::string output_path;
  std::string mapping_path;
  uint32_t storage_buffer_sizes_index;
  uint32_t external_buffer_ceiling;
  std::string transport;
  uint32_t buffer_sizes_offset;
};

std::optional<uint32_t> ParseUInt32(std::string_view value) {
  if (value.empty()) {
    return std::nullopt;
  }
  uint64_t parsed = 0;
  for (const char character : value) {
    if (character < '0' || character > '9') {
      return std::nullopt;
    }
    parsed = parsed * 10 + static_cast<uint64_t>(character - '0');
    if (parsed > std::numeric_limits<uint32_t>::max()) {
      return std::nullopt;
    }
  }
  return static_cast<uint32_t>(parsed);
}

std::optional<Arguments> ParseArguments(int argc, char **argv) {
  if (argc != 10) {
    return std::nullopt;
  }
  const auto size_index = ParseUInt32(argv[6]);
  const auto external_ceiling = ParseUInt32(argv[7]);
  const std::string transport = argv[8];
  const auto buffer_sizes_offset = ParseUInt32(argv[9]);
  if (!size_index || !external_ceiling || *external_ceiling == 0 ||
      *size_index < *external_ceiling || !buffer_sizes_offset ||
      (transport != "immediate" && transport != "ubo") ||
      (transport == "ubo" && *buffer_sizes_offset != 0) ||
      (transport == "immediate" &&
       (*buffer_sizes_offset < sizeof(uint32_t) ||
        *buffer_sizes_offset % sizeof(uint32_t) != 0))) {
    return std::nullopt;
  }
  return Arguments{
      .input_path = argv[1],
      .entry_point = argv[2],
      .emitted_name = argv[3],
      .output_path = argv[4],
      .mapping_path = argv[5],
      .storage_buffer_sizes_index = *size_index,
      .external_buffer_ceiling = *external_ceiling,
      .transport = transport,
      .buffer_sizes_offset = *buffer_sizes_offset,
  };
}

std::optional<std::string> ReadFile(const std::string &path) {
  std::ifstream stream(path, std::ios::binary);
  if (!stream) {
    return std::nullopt;
  }
  std::ostringstream contents;
  contents << stream.rdbuf();
  return contents.str();
}

std::optional<std::vector<Mapping>> ReadMappings(const std::string &path) {
  std::ifstream stream(path);
  if (!stream) {
    return std::nullopt;
  }
  std::vector<Mapping> mappings;
  std::string line;
  while (std::getline(stream, line)) {
    if (line.empty() || line.starts_with('#')) {
      continue;
    }
    std::istringstream fields(line);
    std::string kind;
    uint64_t group = 0;
    uint64_t binding = 0;
    uint64_t metal_index = 0;
    uint64_t count = 0;
    if (!(fields >> kind >> group >> binding >> metal_index >> count) ||
        (fields >> std::ws && !fields.eof()) ||
        group > std::numeric_limits<uint32_t>::max() ||
        binding > std::numeric_limits<uint32_t>::max() ||
        metal_index > std::numeric_limits<uint32_t>::max() || count != 1) {
      std::cerr << "invalid mapping line: " << line << '\n';
      return std::nullopt;
    }
    mappings.push_back(Mapping{
        .kind = std::move(kind),
        .source = tint::BindingPoint{.group = static_cast<uint32_t>(group),
                                     .binding = static_cast<uint32_t>(binding)},
        .metal_index = static_cast<uint32_t>(metal_index),
    });
  }
  return mappings;
}

std::string JsonString(std::string_view value) {
  std::ostringstream output;
  output << '"';
  for (const char character : value) {
    switch (character) {
    case '\\':
      output << "\\\\";
      break;
    case '"':
      output << "\\\"";
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
      output << character;
      break;
    }
  }
  output << '"';
  return output.str();
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

std::optional<std::string>
ResourceKind(tint::inspector::ResourceBinding::ResourceType type) {
  using Type = tint::inspector::ResourceBinding::ResourceType;
  switch (type) {
  case Type::kUniformBuffer:
    return "uniform";
  case Type::kStorageBuffer:
  case Type::kReadOnlyStorageBuffer:
    return "storage";
  default:
    return std::nullopt;
  }
}

bool AddMapping(tint::Bindings &bindings, const Mapping &mapping) {
  const tint::BindingPoint target{.group = 0, .binding = mapping.metal_index};
  if (mapping.kind == "storage") {
    return bindings.storage.emplace(mapping.source, target).second;
  }
  if (mapping.kind == "uniform") {
    return bindings.uniform.emplace(mapping.source, target).second;
  }
  return false;
}

bool SameBindingPoint(const tint::BindingPoint &left,
                      const tint::BindingPoint &right) {
  return left.group == right.group && left.binding == right.binding;
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

bool ValidateMappings(const std::vector<Mapping> &mappings,
                      uint32_t internal_index, uint32_t external_ceiling) {
  std::set<std::tuple<uint32_t, uint32_t>> sources;
  std::set<uint32_t> targets;
  for (const auto &mapping : mappings) {
    if (mapping.kind != "storage" && mapping.kind != "uniform") {
      std::cerr << "mapping contains a non-buffer resource kind\n";
      return false;
    }
    if (!sources.emplace(mapping.source.group, mapping.source.binding).second) {
      std::cerr << "mapping repeats a WGSL binding point\n";
      return false;
    }
    if (!targets.insert(mapping.metal_index).second) {
      std::cerr << "mapping repeats a Metal buffer index\n";
      return false;
    }
    if (mapping.metal_index == internal_index) {
      std::cerr << "user buffer collides with storage-buffer-sizes slot\n";
      return false;
    }
    const uint64_t projected_end =
        static_cast<uint64_t>(mapping.metal_index) + 1;
    if (projected_end > external_ceiling) {
      std::cerr << "projected Metal buffer interval crosses external ceiling\n";
      return false;
    }
  }
  return !mappings.empty();
}

struct EmittedSlot {
  uint32_t index;
  bool internal;
};

std::optional<std::vector<EmittedSlot>>
ValidateEmittedSlots(tint::core::ir::Module &ir,
                     const std::vector<Mapping> &mappings,
                     uint32_t internal_index) {
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
      if (binding->group != 0 ||
          !parameter->Type()->Is<tint::core::type::MemoryView>()) {
        std::cerr
            << "MSL lowering emitted a non-buffer or nonzero-group binding\n";
        return std::nullopt;
      }
      const bool declared_user = std::any_of(
          mappings.begin(), mappings.end(), [&](const auto &mapping) {
            return binding->binding == mapping.metal_index;
          });
      const bool declared_internal = binding->binding == internal_index;
      if (!declared_user && !declared_internal) {
        std::cerr << "MSL lowering emitted an undeclared buffer binding\n";
        return std::nullopt;
      }
      emitted.push_back(EmittedSlot{binding->binding, declared_internal});
    }
  }
  std::sort(emitted.begin(), emitted.end(),
            [](const auto &left, const auto &right) {
              return left.index < right.index;
            });
  for (size_t index = 1; index < emitted.size(); ++index) {
    if (emitted[index - 1].index == emitted[index].index) {
      std::cerr << "MSL lowering emitted duplicate buffer bindings\n";
      return std::nullopt;
    }
  }
  for (const auto &mapping : mappings) {
    if (std::none_of(emitted.begin(), emitted.end(), [&](const auto &slot) {
          return !slot.internal && slot.index == mapping.metal_index;
        })) {
      std::cerr << "MSL lowering omitted a requested buffer binding\n";
      return std::nullopt;
    }
  }
  if (std::none_of(emitted.begin(), emitted.end(), [&](const auto &slot) {
        return slot.internal && slot.index == internal_index;
      })) {
    std::cerr << "MSL lowering omitted storage-buffer-sizes binding\n";
    return std::nullopt;
  }
  return emitted;
}

int Run(const Arguments &arguments) {
  const auto source_text = ReadFile(arguments.input_path);
  const auto mappings = ReadMappings(arguments.mapping_path);
  if (!source_text || !mappings) {
    std::cerr << "could not read input or mapping\n";
    return 1;
  }
  if (!ValidateMappings(*mappings, arguments.storage_buffer_sizes_index,
                        arguments.external_buffer_ceiling)) {
    return 1;
  }

  tint::Source::File source_file(arguments.input_path, *source_text);
  auto program = tint::wgsl::reader::Parse(&source_file, {});
  if (!program.IsValid()) {
    std::cerr << program.Diagnostics().Str();
    return 1;
  }
  tint::inspector::Inspector inspector(program);
  const auto entry_point = inspector.GetEntryPoint(arguments.entry_point);
  const auto reflected = inspector.GetResourceBindings(arguments.entry_point);
  if (!inspector.error().empty()) {
    std::cerr << inspector.error() << '\n';
    return 1;
  }
  if (reflected.size() != mappings->size()) {
    std::cerr << "mapping count differs from selected-entry reflection\n";
    return 1;
  }
  for (const auto &resource : reflected) {
    const auto kind = ResourceKind(resource.resource_type);
    const auto match =
        std::find_if(mappings->begin(), mappings->end(), [&](const auto &item) {
          return kind && item.kind == *kind &&
                 item.source.group == resource.bind_group &&
                 item.source.binding == resource.binding;
        });
    if (!kind || match == mappings->end() ||
        resource.array_size.value_or(1) != 1) {
      std::cerr << "mapping differs from selected-entry reflection\n";
      return 1;
    }
  }

  tint::Bindings bindings;
  for (const auto &mapping : *mappings) {
    if (!AddMapping(bindings, mapping)) {
      std::cerr << "mapping could not be applied to Tint\n";
      return 1;
    }
  }

  auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (ir_result != tint::Success) {
    std::cerr << ir_result.Failure() << '\n';
    return 1;
  }
  auto &ir = ir_result.Get();

  const auto runtime_storage =
      RuntimeStorageBindings(ir, arguments.entry_point);
  if (runtime_storage.empty()) {
    std::cerr << "selected entry has no runtime-sized storage buffers\n";
    return 1;
  }

  tint::msl::writer::ArrayLengthOptions array_lengths;
  if (arguments.transport == "ubo") {
    array_lengths.ubo_binding = arguments.storage_buffer_sizes_index;
  } else {
    array_lengths.buffer_sizes_offset = arguments.buffer_sizes_offset;
  }
  uint32_t highest_storage_index = 0;
  for (const auto &binding_point : runtime_storage) {
    const auto mapping =
        std::find_if(mappings->begin(), mappings->end(), [&](const auto &item) {
          return item.kind == "storage" &&
                 SameBindingPoint(item.source, binding_point);
        });
    if (mapping == mappings->end() ||
        !array_lengths.bindpoint_to_size_index
             .emplace(binding_point, mapping->metal_index)
             .second) {
      std::cerr
          << "runtime storage size-word mapping is missing or not unique\n";
      return 1;
    }
    highest_storage_index =
        std::max(highest_storage_index, mapping->metal_index);
  }

  tint::msl::writer::Options writer_options;
  writer_options.entry_point_name = arguments.entry_point;
  writer_options.remapped_entry_point_name = arguments.emitted_name;
  writer_options.bindings = bindings;
  writer_options.array_length_from_constants = array_lengths;
  if (arguments.transport == "immediate") {
    writer_options.immediate_binding_point = tint::BindingPoint{
        .group = 0, .binding = arguments.storage_buffer_sizes_index};
    writer_options.non_constant_zero_offset = 0;
  }
  auto output = tint::msl::writer::Generate(ir, writer_options);
  if (output != tint::Success) {
    std::cerr << output.Failure() << '\n';
    return 1;
  }
  if (!output->needs_storage_buffer_sizes) {
    std::cerr
        << "Tint did not request the configured storage-buffer-sizes table\n";
    return 1;
  }
  const auto emitted_slots =
      ValidateEmittedSlots(ir, *mappings, arguments.storage_buffer_sizes_index);
  if (!emitted_slots) {
    return 1;
  }
  std::ofstream output_file(arguments.output_path, std::ios::binary);
  output_file << output->msl;
  if (!output_file) {
    std::cerr << "could not write MSL output\n";
    return 1;
  }

  auto ordered = *mappings;
  std::sort(ordered.begin(), ordered.end(),
            [](const auto &left, const auto &right) {
              return std::tie(left.source.group, left.source.binding) <
                     std::tie(right.source.group, right.source.binding);
            });
  const uint32_t word_count = highest_storage_index + 1;
  const uint32_t padded_word_count = ((word_count + 3) / 4) * 4;
  const uint32_t payload_byte_length = word_count * sizeof(uint32_t);
  const uint32_t shader_table_byte_length =
      arguments.transport == "ubo" ? padded_word_count * sizeof(uint32_t)
                                   : payload_byte_length;
  const uint32_t unaligned_upload_byte_length =
      arguments.transport == "ubo"
          ? shader_table_byte_length
          : arguments.buffer_sizes_offset + payload_byte_length;
  const uint32_t upload_byte_length =
      ((unaligned_upload_byte_length + 15) / 16) * 16;
  std::cout << "{\n";
  std::cout << "  \"entryPoint\": " << JsonString(arguments.entry_point)
            << ",\n";
  std::cout << "  \"emittedEntryPoint\": " << JsonString(arguments.emitted_name)
            << ",\n";
  std::cout << "  \"stage\": " << JsonString(StageName(entry_point.stage))
            << ",\n";
  std::cout << "  \"needsStorageBufferSizes\": true,\n";
  std::cout << "  \"transport\": " << JsonString(arguments.transport) << ",\n";
  std::cout << "  \"storageBufferSizesIndex\": "
            << arguments.storage_buffer_sizes_index << ",\n";
  std::cout << "  \"wordCount\": " << word_count << ",\n";
  std::cout << "  \"bufferSizesOffset\": "
            << (arguments.transport == "immediate"
                    ? std::to_string(arguments.buffer_sizes_offset)
                    : "null")
            << ",\n";
  std::cout << "  \"payloadByteLength\": " << payload_byte_length << ",\n";
  std::cout << "  \"shaderTableByteLength\": " << shader_table_byte_length
            << ",\n";
  std::cout << "  \"uploadByteLength\": " << upload_byte_length << ",\n";
  std::cout << "  \"postLoweringBufferIndices\": [";
  for (size_t index = 0; index < emitted_slots->size(); ++index) {
    std::cout << (*emitted_slots)[index].index
              << (index + 1 == emitted_slots->size() ? "" : ", ");
  }
  std::cout << "],\n";
  std::cout << "  \"bindings\": [\n";
  for (size_t index = 0; index < ordered.size(); ++index) {
    const auto &mapping = ordered[index];
    std::cout << "    {\"kind\": " << JsonString(mapping.kind)
              << ", \"group\": " << mapping.source.group
              << ", \"binding\": " << mapping.source.binding
              << ", \"metalIndex\": " << mapping.metal_index
              << ", \"sizeWordIndex\": "
              << (std::any_of(runtime_storage.begin(), runtime_storage.end(),
                              [&](const auto &item) {
                                return SameBindingPoint(item, mapping.source);
                              })
                      ? std::to_string(mapping.metal_index)
                      : "null")
              << "}" << (index + 1 == ordered.size() ? "\n" : ",\n");
  }
  std::cout << "  ]\n}\n";
  return 0;
}

} // namespace

int main(int argc, char **argv) {
  const auto arguments = ParseArguments(argc, argv);
  if (!arguments) {
    std::cerr << "usage: wrapper <input.wgsl> <entry> <emitted> <output.metal> "
                 "<mapping.txt> <storage-buffer-sizes-index> "
                 "<external-buffer-ceiling> <immediate|ubo> "
                 "<buffer-sizes-offset-or-zero>\n";
    return 64;
  }
  tint::Initialize();
  const int result = Run(*arguments);
  tint::Shutdown();
  return result;
}
