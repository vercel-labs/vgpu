// Feasibility prototype only. This is not a public compiler protocol.
//
// The wrapper deliberately owns one fixed, versioned Metal immediate-data
// layout instead of reproducing Dawn's pipeline-dependent compact mask.

#include <cstdint>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "src/tint/api/common/bindings.h"
#include "src/tint/api/tint.h"
#include "src/tint/lang/msl/writer/writer.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"

namespace {

constexpr std::string_view kLayout = "vgpu-metal-immediate-data-layout-v1";
constexpr uint32_t kImmediateBufferIndex = 30;
constexpr uint32_t kNonConstantZeroOffset = 0;
constexpr uint32_t kVertexComputeSizesOffset = 4;
constexpr uint32_t kFragmentDepthMinOffset = 4;
constexpr uint32_t kFragmentDepthMaxOffset = 8;
constexpr uint32_t kFragmentSizesOffset = 12;

struct Arguments {
  std::string input_path;
  std::string entry_point;
  std::string emitted_name;
  std::string output_path;
};

std::optional<Arguments> ParseArguments(int argc, char **argv) {
  if (argc != 5) {
    return std::nullopt;
  }
  return Arguments{
      .input_path = argv[1],
      .entry_point = argv[2],
      .emitted_name = argv[3],
      .output_path = argv[4],
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

bool IsStorage(tint::inspector::ResourceBinding::ResourceType type) {
  using Type = tint::inspector::ResourceBinding::ResourceType;
  return type == Type::kStorageBuffer || type == Type::kReadOnlyStorageBuffer;
}

int Run(const Arguments &arguments) {
  const auto source_text = ReadFile(arguments.input_path);
  if (!source_text) {
    std::cerr << "could not read WGSL input\n";
    return 1;
  }

  tint::Source::File source_file(arguments.input_path, *source_text);
  auto program = tint::wgsl::reader::Parse(&source_file, {});
  if (!program.IsValid()) {
    std::cerr << program.Diagnostics().Str();
    return 1;
  }

  tint::inspector::Inspector inspector(program);
  const auto entry = inspector.GetEntryPoint(arguments.entry_point);
  const auto resources = inspector.GetResourceBindings(arguments.entry_point);
  if (!inspector.error().empty()) {
    std::cerr << inspector.error() << '\n';
    return 1;
  }
  if (resources.empty()) {
    std::cerr << "selected entry has no reflected storage resources\n";
    return 1;
  }

  bool saw_runtime_values = false;
  bool saw_compute_result = false;
  tint::Bindings bindings;
  for (const auto &resource : resources) {
    if (!IsStorage(resource.resource_type) ||
        resource.array_size.value_or(1) != 1 || resource.bind_group != 0 ||
        resource.binding > 1) {
      std::cerr << "selected entry has an unexpected reflected resource\n";
      return 1;
    }
    const tint::BindingPoint point{.group = 0, .binding = resource.binding};
    if (!bindings.storage.emplace(point, point).second) {
      std::cerr << "selected entry repeats a reflected storage resource\n";
      return 1;
    }
    saw_runtime_values |= resource.binding == 0;
    saw_compute_result |= resource.binding == 1;
  }
  if (!saw_runtime_values ||
      (entry.stage == tint::inspector::PipelineStage::kCompute) !=
          saw_compute_result ||
      resources.size() != (saw_compute_result ? 2u : 1u)) {
    std::cerr << "selected-entry resource shape drifted\n";
    return 1;
  }

  auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (ir_result != tint::Success) {
    std::cerr << ir_result.Failure() << '\n';
    return 1;
  }
  auto &ir = ir_result.Get();

  const bool fragment =
      entry.stage == tint::inspector::PipelineStage::kFragment;
  const uint32_t sizes_offset =
      fragment ? kFragmentSizesOffset : kVertexComputeSizesOffset;

  tint::msl::writer::ArrayLengthOptions array_lengths;
  array_lengths.buffer_sizes_offset = sizes_offset;
  array_lengths.bindpoint_to_size_index.emplace(
      tint::BindingPoint{.group = 0, .binding = 0}, 0);

  tint::msl::writer::Options writer_options;
  writer_options.entry_point_name = arguments.entry_point;
  writer_options.remapped_entry_point_name = arguments.emitted_name;
  writer_options.bindings = std::move(bindings);
  writer_options.immediate_binding_point =
      tint::BindingPoint{.group = 0, .binding = kImmediateBufferIndex};
  writer_options.non_constant_zero_offset = kNonConstantZeroOffset;
  writer_options.array_length_from_constants = std::move(array_lengths);
  if (fragment && entry.frag_depth_used) {
    writer_options.depth_range_offsets = {
        kFragmentDepthMinOffset,
        kFragmentDepthMaxOffset,
    };
  }

  auto output = tint::msl::writer::Generate(ir, writer_options);
  if (output != tint::Success) {
    std::cerr << output.Failure() << '\n';
    return 1;
  }
  if (!output->needs_storage_buffer_sizes) {
    std::cerr << "Tint did not request the storage-buffer-size region\n";
    return 1;
  }

  std::ofstream output_file(arguments.output_path, std::ios::binary);
  output_file << output->msl;
  if (!output_file) {
    std::cerr << "could not write MSL output\n";
    return 1;
  }

  std::cout << "{\n";
  std::cout << "  \"layout\": " << JsonString(kLayout) << ",\n";
  std::cout << "  \"entryPoint\": " << JsonString(arguments.entry_point)
            << ",\n";
  std::cout << "  \"emittedEntryPoint\": " << JsonString(arguments.emitted_name)
            << ",\n";
  std::cout << "  \"stage\": " << JsonString(StageName(entry.stage)) << ",\n";
  std::cout << "  \"immediateBufferIndex\": " << kImmediateBufferIndex << ",\n";
  std::cout << "  \"nonConstantZeroOffset\": " << kNonConstantZeroOffset
            << ",\n";
  std::cout << "  \"storageBufferSizesOffset\": " << sizes_offset << ",\n";
  std::cout << "  \"fragDepthUsed\": "
            << (entry.frag_depth_used ? "true" : "false") << ",\n";
  std::cout << "  \"depthMinOffset\": "
            << (fragment ? std::to_string(kFragmentDepthMinOffset) : "null")
            << ",\n";
  std::cout << "  \"depthMaxOffset\": "
            << (fragment ? std::to_string(kFragmentDepthMaxOffset) : "null")
            << ",\n";
  std::cout << "  \"configuredDepthRange\": "
            << (fragment && entry.frag_depth_used ? "true" : "false") << "\n";
  std::cout << "}\n";
  return 0;
}

} // namespace

int main(int argc, char **argv) {
  const auto arguments = ParseArguments(argc, argv);
  if (!arguments) {
    std::cerr
        << "usage: wrapper <input.wgsl> <entry> <emitted> <output.metal>\n";
    return 64;
  }
  tint::Initialize();
  const int result = Run(*arguments);
  tint::Shutdown();
  return result;
}
