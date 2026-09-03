// Feasibility prototype only.
//
// This demonstrates direct Tint parsing, inspection, layout reflection, entry-point renaming,
// binding projection, and MSL generation. It is not the production process protocol:
// GenerateBindings is a temporary oracle, diagnostics are not yet structured, and the CLI shape is
// intentionally small. Production must receive a versioned vgpu binding map instead.

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include "src/tint/api/helpers/generate_bindings.h"
#include "src/tint/api/tint.h"
#include "src/tint/lang/core/ir/referenced_module_vars.h"
#include "src/tint/lang/core/type/array.h"
#include "src/tint/lang/core/type/pointer.h"
#include "src/tint/lang/core/type/struct.h"
#include "src/tint/lang/msl/writer/writer.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"

namespace {

struct Arguments {
    std::string input_path;
    std::string entry_point;
    std::string emitted_name;
    std::string output_path;
    bool uniform_buffer_standard_layout = false;
    bool unrestricted_pointer_parameters = false;
};

std::optional<Arguments> ParseArguments(int argc, char** argv) {
    if (argc < 5) {
        return std::nullopt;
    }
    Arguments arguments{
        .input_path = argv[1],
        .entry_point = argv[2],
        .emitted_name = argv[3],
        .output_path = argv[4],
    };
    for (int index = 5; index < argc; ++index) {
        const std::string_view flag = argv[index];
        if (flag == "--uniform-buffer-standard-layout") {
            arguments.uniform_buffer_standard_layout = true;
        } else if (flag == "--unrestricted-pointer-parameters") {
            arguments.unrestricted_pointer_parameters = true;
        } else {
            std::cerr << "unknown feature flag: " << flag << '\n';
            return std::nullopt;
        }
    }
    return arguments;
}

std::optional<std::string> ReadFile(const std::string& path) {
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
            case '\\': output << "\\\\"; break;
            case '"': output << "\\\""; break;
            case '\n': output << "\\n"; break;
            case '\r': output << "\\r"; break;
            case '\t': output << "\\t"; break;
            default: output << character; break;
        }
    }
    output << '"';
    return output.str();
}

const char* StageName(tint::inspector::PipelineStage stage) {
    switch (stage) {
        case tint::inspector::PipelineStage::kVertex: return "vertex";
        case tint::inspector::PipelineStage::kFragment: return "fragment";
        case tint::inspector::PipelineStage::kCompute: return "compute";
    }
    return "unknown";
}

struct Slot {
    std::string kind;
    tint::BindingPoint source;
    tint::BindingPoint target;
};

void AppendSlots(std::vector<Slot>& slots,
                 std::string kind,
                 const tint::BindingMap& bindings) {
    for (const auto& [source, target] : bindings) {
        slots.push_back(Slot{kind, source, target});
    }
}

tint::msl::writer::ArrayLengthOptions ArrayLengthOptions(
    tint::core::ir::Module& ir,
    const std::string& entry_point) {
    tint::msl::writer::ArrayLengthOptions options{.ubo_binding = 30};

    tint::core::ir::Function* entry_function = nullptr;
    for (auto* function : ir.functions) {
        if (function->IsEntryPoint() && ir.NameOf(function).NameView() == entry_point) {
            entry_function = function;
            break;
        }
    }
    if (!entry_function) {
        return options;
    }

    tint::core::ir::ReferencedModuleVars<const tint::core::ir::Module> referenced_vars{ir};
    const auto& references = referenced_vars.TransitiveReferences(entry_function);
    std::vector<tint::BindingPoint> storage_bindings;
    for (auto* variable : references) {
        const auto binding_point = variable->BindingPoint();
        if (!binding_point) {
            continue;
        }
        const auto* pointer = variable->Result()->Type()->As<tint::core::type::Pointer>();
        if (pointer && pointer->AddressSpace() == tint::core::AddressSpace::kStorage &&
            !pointer->HasFixedFootprint()) {
            storage_bindings.push_back(*binding_point);
        }
    }
    std::sort(storage_bindings.begin(), storage_bindings.end(), [](const auto& left, const auto& right) {
        return std::tie(left.group, left.binding) < std::tie(right.group, right.binding);
    });
    storage_bindings.erase(
        std::unique(storage_bindings.begin(), storage_bindings.end(), [](const auto& left, const auto& right) {
            return left.group == right.group && left.binding == right.binding;
        }),
        storage_bindings.end());
    for (size_t index = 0; index < storage_bindings.size(); ++index) {
        options.bindpoint_to_size_index.emplace(storage_bindings[index], static_cast<uint32_t>(index));
    }
    return options;
}

void WriteStructures(const tint::Program& program) {
    std::vector<const tint::core::type::Struct*> structures;
    for (const auto* type : program.Types()) {
        if (const auto* structure = type->As<tint::core::type::Struct>();
            structure && !structure->IsWgslInternal()) {
            structures.push_back(structure);
        }
    }
    std::sort(structures.begin(), structures.end(), [](const auto* left, const auto* right) {
        return left->FriendlyName() < right->FriendlyName();
    });

    std::cout << "  \"structures\": [\n";
    for (size_t structure_index = 0; structure_index < structures.size(); ++structure_index) {
        const auto* structure = structures[structure_index];
        std::cout << "    {\"name\": " << JsonString(structure->FriendlyName())
                  << ", \"align\": " << structure->Align()
                  << ", \"size\": " << structure->Size()
                  << ", \"members\": [";
        for (size_t member_index = 0; member_index < structure->Members().Length(); ++member_index) {
            const auto* member = structure->Members()[member_index];
            if (member_index > 0) {
                std::cout << ", ";
            }
            std::cout << "{\"name\": " << JsonString(member->Name().Name())
                      << ", \"offset\": " << member->Offset()
                      << ", \"align\": " << member->Align()
                      << ", \"size\": " << member->Size();
            if (const auto* array = member->Type()->As<tint::core::type::Array>()) {
                std::cout << ", \"arrayStride\": " << array->ImplicitStride();
            }
            std::cout << '}';
        }
        std::cout << "]}" << (structure_index + 1 == structures.size() ? "\n" : ",\n");
    }
    std::cout << "  ],\n";
}

int Run(const Arguments& arguments) {
    const auto source_text = ReadFile(arguments.input_path);
    if (!source_text) {
        std::cerr << "could not read input: " << arguments.input_path << '\n';
        return 1;
    }

    tint::Source::File source_file(arguments.input_path, *source_text);
    tint::wgsl::reader::Options reader_options;
    if (arguments.uniform_buffer_standard_layout) {
        reader_options.allowed_features.features.insert(
            tint::wgsl::LanguageFeature::kUniformBufferStandardLayout);
    }
    if (arguments.unrestricted_pointer_parameters) {
        reader_options.allowed_features.features.insert(
            tint::wgsl::LanguageFeature::kUnrestrictedPointerParameters);
    }
    auto program = tint::wgsl::reader::Parse(&source_file, reader_options);
    if (!program.IsValid()) {
        std::cerr << program.Diagnostics().Str();
        return 1;
    }

    tint::inspector::Inspector inspector(program);
    const auto entry_point = inspector.GetEntryPoint(arguments.entry_point);
    if (!inspector.error().empty()) {
        std::cerr << inspector.error() << '\n';
        return 1;
    }
    const auto reflected_bindings = inspector.GetResourceBindings(arguments.entry_point);
    if (!inspector.error().empty()) {
        std::cerr << inspector.error() << '\n';
        return 1;
    }

    auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
    if (ir_result != tint::Success) {
        std::cerr << ir_result.Failure() << '\n';
        return 1;
    }
    auto& ir = ir_result.Get();

    // Spike oracle only. Production must construct this mapping from the versioned vgpu ABI.
    const tint::Bindings bindings = tint::GenerateBindings(ir, arguments.entry_point, true, true);
    tint::msl::writer::Options writer_options;
    writer_options.entry_point_name = arguments.entry_point;
    writer_options.remapped_entry_point_name = arguments.emitted_name;
    writer_options.bindings = bindings;
    writer_options.immediate_binding_point = tint::BindingPoint{.group = 0, .binding = 30};
    writer_options.array_length_from_constants = ArrayLengthOptions(ir, arguments.entry_point);

    auto output = tint::msl::writer::Generate(ir, writer_options);
    if (output != tint::Success) {
        std::cerr << output.Failure() << '\n';
        return 1;
    }
    std::ofstream output_file(arguments.output_path, std::ios::binary);
    output_file << output->msl;
    if (!output_file) {
        std::cerr << "could not write output: " << arguments.output_path << '\n';
        return 1;
    }

    std::vector<Slot> slots;
    AppendSlots(slots, "uniform-buffer", bindings.uniform);
    AppendSlots(slots, "storage-buffer", bindings.storage);
    AppendSlots(slots, "texture", bindings.texture);
    AppendSlots(slots, "storage-texture", bindings.storage_texture);
    AppendSlots(slots, "texel-buffer", bindings.texel_buffer);
    AppendSlots(slots, "sampler", bindings.sampler);
    AppendSlots(slots, "input-attachment", bindings.input_attachment);
    std::sort(slots.begin(), slots.end(), [](const Slot& left, const Slot& right) {
        return std::tie(left.kind, left.source.group, left.source.binding) <
               std::tie(right.kind, right.source.group, right.source.binding);
    });

    std::cout << "{\n";
    std::cout << "  \"sourceEntryPoint\": " << JsonString(arguments.entry_point) << ",\n";
    std::cout << "  \"emittedEntryPoint\": " << JsonString(arguments.emitted_name) << ",\n";
    std::cout << "  \"stage\": " << JsonString(StageName(entry_point.stage)) << ",\n";
    std::cout << "  \"languageFeatures\": {\"uniformBufferStandardLayout\": "
              << (arguments.uniform_buffer_standard_layout ? "true" : "false")
              << ", \"unrestrictedPointerParameters\": "
              << (arguments.unrestricted_pointer_parameters ? "true" : "false") << "},\n";
    std::cout << "  \"workgroup\": {\"x\": " << output->workgroup_info.x
              << ", \"y\": " << output->workgroup_info.y
              << ", \"z\": " << output->workgroup_info.z
              << ", \"storageBytes\": " << output->workgroup_info.storage_size << "},\n";
    std::cout << "  \"needsStorageBufferSizes\": "
              << (output->needs_storage_buffer_sizes ? "true" : "false") << ",\n";
    std::cout << "  \"inputs\": " << entry_point.input_variables.size() << ",\n";
    std::cout << "  \"outputs\": " << entry_point.output_variables.size() << ",\n";
    WriteStructures(program);
    std::cout << "  \"bindings\": [\n";
    for (size_t index = 0; index < slots.size(); ++index) {
        const auto& slot = slots[index];
        std::string variable_name;
        for (const auto& reflected : reflected_bindings) {
            if (reflected.bind_group == slot.source.group &&
                reflected.binding == slot.source.binding) {
                variable_name = reflected.variable_name;
                break;
            }
        }
        std::cout << "    {\"kind\": " << JsonString(slot.kind)
                  << ", \"name\": " << JsonString(variable_name)
                  << ", \"group\": " << slot.source.group
                  << ", \"binding\": " << slot.source.binding
                  << ", \"metalIndex\": " << slot.target.binding << "}"
                  << (index + 1 == slots.size() ? "\n" : ",\n");
    }
    std::cout << "  ]\n}\n";
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    const auto arguments = ParseArguments(argc, argv);
    if (!arguments) {
        std::cerr << "usage: wrapper <input.wgsl> <entry-point> <emitted-name> <output.metal> "
                     "[--uniform-buffer-standard-layout] "
                     "[--unrestricted-pointer-parameters]\n";
        return 64;
    }
    tint::Initialize();
    const int result = Run(*arguments);
    tint::Shutdown();
    return result;
}
