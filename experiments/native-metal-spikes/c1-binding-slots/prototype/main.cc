// Feasibility prototype only. The process shape is not a public protocol.
//
// Unlike the earlier standalone spike, this wrapper never calls GenerateBindings. It reads a
// vgpu-owned map, constructs tint::Bindings directly, validates that every selected-entry resource
// is mapped exactly once, and passes that same map to the MSL writer.

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
#include "src/tint/lang/core/type/array.h"
#include "src/tint/lang/core/type/binding_array.h"
#include "src/tint/lang/core/type/memory_view.h"
#include "src/tint/lang/core/type/pointer.h"
#include "src/tint/lang/core/type/sampler.h"
#include "src/tint/lang/core/type/texture.h"
#include "src/tint/lang/msl/writer/writer.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"

namespace {

struct Mapping {
    std::string kind;
    tint::BindingPoint source;
    uint32_t index;
    uint32_t count;
};

struct Arguments {
    std::string input_path;
    std::string entry_point;
    std::string emitted_name;
    std::string output_path;
    std::string mapping_path;
    bool sized_binding_array = false;
    std::optional<uint32_t> storage_buffer_sizes_index;
    std::optional<uint32_t> immediate_index;
    bool force_u32_div_mod_immediate = false;
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

std::optional<Arguments> ParseArguments(int argc, char** argv) {
    if (argc < 6) {
        return std::nullopt;
    }
    Arguments arguments{
        .input_path = argv[1],
        .entry_point = argv[2],
        .emitted_name = argv[3],
        .output_path = argv[4],
        .mapping_path = argv[5],
    };
    for (int index = 6; index < argc; ++index) {
        const std::string_view flag = argv[index];
        if (flag == "--sized-binding-array") {
            arguments.sized_binding_array = true;
            continue;
        }
        if (flag == "--storage-buffer-sizes-index" && index + 1 < argc) {
            const auto value = ParseUInt32(argv[++index]);
            if (!value) {
                return std::nullopt;
            }
            arguments.storage_buffer_sizes_index = *value;
            continue;
        }
        if (flag == "--immediate-index" && index + 1 < argc) {
            const auto value = ParseUInt32(argv[++index]);
            if (!value) {
                return std::nullopt;
            }
            arguments.immediate_index = *value;
            continue;
        }
        if (flag == "--force-u32-div-mod-immediate") {
            arguments.force_u32_div_mod_immediate = true;
            continue;
        }
        return std::nullopt;
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

std::optional<std::vector<Mapping>> ReadMappings(const std::string& path) {
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
        uint64_t index = 0;
        uint64_t count = 0;
        if (!(fields >> kind >> group >> binding >> index >> count) ||
            (fields >> std::ws && !fields.eof()) ||
            group > std::numeric_limits<uint32_t>::max() ||
            binding > std::numeric_limits<uint32_t>::max() ||
            index > std::numeric_limits<uint32_t>::max() ||
            count == 0 || count > std::numeric_limits<uint32_t>::max()) {
            std::cerr << "invalid mapping line: " << line << '\n';
            return std::nullopt;
        }
        mappings.push_back(Mapping{
            .kind = std::move(kind),
            .source = tint::BindingPoint{.group = static_cast<uint32_t>(group),
                                        .binding = static_cast<uint32_t>(binding)},
            .index = static_cast<uint32_t>(index),
            .count = static_cast<uint32_t>(count),
        });
    }
    return mappings;
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

std::optional<std::string> ResourceKind(tint::inspector::ResourceBinding::ResourceType type) {
    using Type = tint::inspector::ResourceBinding::ResourceType;
    switch (type) {
        case Type::kUniformBuffer: return "uniform";
        case Type::kStorageBuffer:
        case Type::kReadOnlyStorageBuffer: return "storage";
        case Type::kSampler: return "sampler";
        case Type::kSampledTexture:
        case Type::kMultisampledTexture:
        case Type::kDepthTexture:
        case Type::kDepthMultisampledTexture: return "texture";
        case Type::kWriteOnlyStorageTexture:
        case Type::kReadOnlyStorageTexture:
        case Type::kReadWriteStorageTexture: return "storage-texture";
        case Type::kReadOnlyTexelBuffer:
        case Type::kReadWriteTexelBuffer:
        case Type::kInputAttachment:
        case Type::kExternalTexture: return std::nullopt;
    }
    return std::nullopt;
}

bool SameBindingPoint(const tint::BindingPoint& left, const tint::BindingPoint& right) {
    return left.group == right.group && left.binding == right.binding;
}

bool AddMapping(tint::Bindings& bindings, const Mapping& mapping) {
    const tint::BindingPoint target{.group = 0, .binding = mapping.index};
    tint::BindingMap* destination = nullptr;
    if (mapping.kind == "uniform") destination = &bindings.uniform;
    else if (mapping.kind == "storage") destination = &bindings.storage;
    else if (mapping.kind == "texture") destination = &bindings.texture;
    else if (mapping.kind == "storage-texture") destination = &bindings.storage_texture;
    else if (mapping.kind == "sampler") destination = &bindings.sampler;
    else return false;
    return destination->emplace(mapping.source, target).second;
}

std::vector<tint::BindingPoint> RuntimeStorageBindings(
    tint::core::ir::Module& ir,
    const std::string& entry_point) {
    tint::core::ir::Function* entry_function = nullptr;
    for (auto* function : ir.functions) {
        if (function->IsEntryPoint() && ir.NameOf(function).NameView() == entry_point) {
            entry_function = function;
            break;
        }
    }
    std::vector<tint::BindingPoint> result;
    if (!entry_function) {
        return result;
    }
    tint::core::ir::ReferencedModuleVars<const tint::core::ir::Module> referenced_vars{ir};
    for (auto* variable : referenced_vars.TransitiveReferences(entry_function)) {
        const auto binding_point = variable->BindingPoint();
        const auto* pointer = variable->Result()->Type()->As<tint::core::type::Pointer>();
        if (binding_point && pointer && pointer->AddressSpace() == tint::core::AddressSpace::kStorage &&
            !pointer->StoreType()->HasFixedFootprint()) {
            result.push_back(*binding_point);
        }
    }
    std::sort(result.begin(), result.end(), [](const auto& left, const auto& right) {
        return std::tie(left.group, left.binding) < std::tie(right.group, right.binding);
    });
    result.erase(std::unique(result.begin(), result.end(), SameBindingPoint), result.end());
    return result;
}

std::optional<std::string> ParameterResourceClass(const tint::core::type::Type* type) {
    if (type->Is<tint::core::type::MemoryView>()) {
        return "buffer";
    }
    if (type->Is<tint::core::type::Sampler>()) {
        return "sampler";
    }
    if (type->Is<tint::core::type::Texture>()) {
        return "texture";
    }
    if (const auto* binding_array = type->As<tint::core::type::BindingArray>()) {
        return ParameterResourceClass(binding_array->ElemType());
    }
    if (const auto* array = type->As<tint::core::type::Array>()) {
        return ParameterResourceClass(array->ElemType());
    }
    return std::nullopt;
}

std::optional<uint32_t> ParameterResourceCount(const tint::core::type::Type* type) {
    if (const auto* binding_array = type->As<tint::core::type::BindingArray>()) {
        if (const auto* count =
                binding_array->Count()->As<tint::core::type::ConstantArrayCount>()) {
            return count->value;
        }
        return std::nullopt;
    }
    if (const auto* array = type->As<tint::core::type::Array>()) {
        return array->ConstantCount();
    }
    return 1;
}

std::optional<std::string> MappingResourceClass(const Mapping& mapping) {
    if (mapping.kind == "sampler") {
        return "sampler";
    }
    if (mapping.kind == "texture" || mapping.kind == "storage-texture") {
        return "texture";
    }
    if (mapping.kind == "uniform" || mapping.kind == "storage") {
        return "buffer";
    }
    return std::nullopt;
}

bool ValidateRequestedIntervals(const std::vector<Mapping>& requested,
                                std::optional<uint32_t> storage_buffer_sizes_index,
                                std::optional<uint32_t> immediate_index) {
    struct Interval {
        std::string resource_class;
        uint64_t start;
        uint64_t end;
    };
    std::vector<Interval> intervals;
    for (const auto& mapping : requested) {
        const auto resource_class = MappingResourceClass(mapping);
        const uint64_t end = static_cast<uint64_t>(mapping.index) + mapping.count;
        if (!resource_class || end > static_cast<uint64_t>(std::numeric_limits<uint32_t>::max()) + 1) {
            std::cerr << "unknown mapping kind or binding interval overflow\n";
            return false;
        }
        intervals.push_back(Interval{*resource_class, mapping.index, end});
    }
    for (const auto index : {storage_buffer_sizes_index, immediate_index}) {
        if (index) {
            intervals.push_back(Interval{"buffer", *index, static_cast<uint64_t>(*index) + 1});
        }
    }
    std::sort(intervals.begin(), intervals.end(), [](const auto& left, const auto& right) {
        return std::tie(left.resource_class, left.start, left.end) <
               std::tie(right.resource_class, right.start, right.end);
    });
    for (size_t index = 1; index < intervals.size(); ++index) {
        const auto& previous = intervals[index - 1];
        const auto& current = intervals[index];
        if (previous.resource_class == current.resource_class && current.start < previous.end) {
            std::cerr << "requested binding intervals collide\n";
            return false;
        }
    }
    return true;
}

struct EmittedSlot {
    std::string resource_class;
    uint32_t index;
    uint32_t count;
};

std::optional<std::vector<EmittedSlot>> ValidateEmittedSlots(
    tint::core::ir::Module& ir,
    const std::vector<Mapping>& requested,
    std::optional<uint32_t> storage_buffer_sizes_index,
    std::optional<uint32_t> immediate_index) {
    std::vector<EmittedSlot> emitted;
    for (auto* function : ir.functions) {
        if (!function->IsEntryPoint()) {
            continue;
        }
        for (auto* parameter : function->Params()) {
            const auto binding = parameter->BindingPoint();
            if (!binding) {
                continue;
            }
            if (binding->group != 0) {
                std::cerr << "MSL lowering emitted a nonzero binding group\n";
                return std::nullopt;
            }
            const auto resource_class = ParameterResourceClass(parameter->Type());
            const auto resource_count = ParameterResourceCount(parameter->Type());
            if (!resource_class || !resource_count) {
                std::cerr << "MSL lowering emitted an unclassified or unsized bound parameter\n";
                return std::nullopt;
            }
            const bool declared_user = std::any_of(
                requested.begin(), requested.end(), [&](const auto& mapping) {
                    return MappingResourceClass(mapping) == resource_class &&
                           binding->binding == mapping.index &&
                           *resource_count == mapping.count;
                });
            const bool declared_internal =
                *resource_class == "buffer" && *resource_count == 1 &&
                (binding->binding == storage_buffer_sizes_index ||
                 binding->binding == immediate_index);
            if (!declared_user && !declared_internal) {
                std::cerr << "MSL lowering emitted an undeclared binding\n";
                return std::nullopt;
            }
            emitted.push_back(
                EmittedSlot{*resource_class, binding->binding, *resource_count});
        }
    }
    std::sort(emitted.begin(), emitted.end(), [](const auto& left, const auto& right) {
        return std::tie(left.resource_class, left.index, left.count) <
               std::tie(right.resource_class, right.index, right.count);
    });
    for (size_t index = 1; index < emitted.size(); ++index) {
        const auto& previous = emitted[index - 1];
        const auto& current = emitted[index];
        const uint64_t previous_end =
            static_cast<uint64_t>(previous.index) + previous.count;
        if (previous.resource_class == current.resource_class &&
            current.index < previous_end) {
            std::cerr << "MSL lowering emitted overlapping bindings\n";
            return std::nullopt;
        }
    }
    for (const auto& mapping : requested) {
        if (std::none_of(emitted.begin(), emitted.end(), [&](const auto& slot) {
                return MappingResourceClass(mapping) == slot.resource_class &&
                       slot.index == mapping.index && slot.count == mapping.count;
            })) {
            std::cerr << "MSL lowering omitted a requested binding\n";
            return std::nullopt;
        }
    }
    return emitted;
}

int Run(const Arguments& arguments) {
    const auto source_text = ReadFile(arguments.input_path);
    const auto requested = ReadMappings(arguments.mapping_path);
    if (!source_text || !requested) {
        std::cerr << "could not read input or mapping\n";
        return 1;
    }
    if (!ValidateRequestedIntervals(*requested, arguments.storage_buffer_sizes_index,
                                    arguments.immediate_index)) {
        return 1;
    }

    tint::Source::File source_file(arguments.input_path, *source_text);
    tint::wgsl::reader::Options reader_options;
    if (arguments.sized_binding_array) {
        reader_options.allowed_features.features.insert(
            tint::wgsl::LanguageFeature::kSizedBindingArray);
    }
    auto program = tint::wgsl::reader::Parse(&source_file, reader_options);
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

    if (reflected.size() != requested->size()) {
        std::cerr << "requested binding count does not match selected-entry reflection\n";
        return 1;
    }
    for (const auto& resource : reflected) {
        const auto kind = ResourceKind(resource.resource_type);
        if (!kind) {
            std::cerr << "selected entry uses an unsupported external-texture expansion\n";
            return 1;
        }
        const auto match = std::find_if(requested->begin(), requested->end(), [&](const auto& item) {
            return item.kind == *kind && item.source.group == resource.bind_group &&
                   item.source.binding == resource.binding;
        });
        const uint32_t reflected_count = resource.array_size.value_or(1);
        if (match == requested->end() || match->count != reflected_count) {
            std::cerr << "requested binding map differs from selected-entry reflection\n";
            return 1;
        }
    }

    tint::Bindings bindings;
    for (const auto& mapping : *requested) {
        if (!AddMapping(bindings, mapping)) {
            std::cerr << "unknown or duplicate mapping\n";
            return 1;
        }
    }

    auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
    if (ir_result != tint::Success) {
        std::cerr << ir_result.Failure() << '\n';
        return 1;
    }
    auto& ir = ir_result.Get();
    const auto runtime_storage = RuntimeStorageBindings(ir, arguments.entry_point);
    if (!runtime_storage.empty() && !arguments.storage_buffer_sizes_index) {
        std::cerr << "selected entry requires a storage-buffer-sizes slot\n";
        return 1;
    }

    tint::msl::writer::ArrayLengthOptions array_lengths;
    if (!runtime_storage.empty()) {
        array_lengths.ubo_binding = *arguments.storage_buffer_sizes_index;
        for (const auto& binding_point : runtime_storage) {
            const auto mapping =
                std::find_if(requested->begin(), requested->end(), [&](const auto& item) {
                    return item.kind == "storage" &&
                           SameBindingPoint(item.source, binding_point);
                });
            if (mapping == requested->end() ||
                !array_lengths.bindpoint_to_size_index
                     .emplace(binding_point, mapping->index)
                     .second) {
                std::cerr << "runtime storage size-word mapping is missing or not unique\n";
                return 1;
            }
        }
    }

    tint::msl::writer::Options writer_options;
    writer_options.entry_point_name = arguments.entry_point;
    writer_options.remapped_entry_point_name = arguments.emitted_name;
    writer_options.bindings = bindings;
    writer_options.array_length_from_constants = array_lengths;
    writer_options.immediate_binding_point = arguments.immediate_index
                                                 ? std::optional<tint::BindingPoint>(
                                                       tint::BindingPoint{
                                                           .group = 0,
                                                           .binding = *arguments.immediate_index,
                                                       })
                                                 : std::nullopt;
    if (arguments.force_u32_div_mod_immediate) {
        writer_options.workarounds.fix_u32_div_mod = true;
        writer_options.disable_polyfill_integer_div_mod = true;
    }

    auto output = tint::msl::writer::Generate(ir, writer_options);
    if (output != tint::Success) {
        std::cerr << output.Failure() << '\n';
        return 1;
    }
    const auto emitted_slots = ValidateEmittedSlots(ir, *requested,
                                                    arguments.storage_buffer_sizes_index,
                                                    arguments.immediate_index);
    if (!emitted_slots) {
        return 1;
    }
    const auto uses_buffer_index = [&](std::optional<uint32_t> index) {
        return index && std::any_of(emitted_slots->begin(), emitted_slots->end(), [&](const auto& slot) {
                   return slot.resource_class == "buffer" && slot.index == *index;
               });
    };
    const bool used_storage_buffer_sizes = uses_buffer_index(arguments.storage_buffer_sizes_index);
    const bool used_immediate = uses_buffer_index(arguments.immediate_index);
    if (used_storage_buffer_sizes != output->needs_storage_buffer_sizes) {
        std::cerr << "storage-buffer-size metadata disagrees with the lowered entry interface\n";
        return 1;
    }
    std::ofstream output_file(arguments.output_path, std::ios::binary);
    output_file << output->msl;
    if (!output_file) {
        std::cerr << "could not write MSL output\n";
        return 1;
    }

    auto ordered = *requested;
    std::sort(ordered.begin(), ordered.end(), [](const auto& left, const auto& right) {
        return std::tie(left.kind, left.source.group, left.source.binding) <
               std::tie(right.kind, right.source.group, right.source.binding);
    });
    std::cout << "{\n";
    std::cout << "  \"entryPoint\": " << JsonString(arguments.entry_point) << ",\n";
    std::cout << "  \"emittedEntryPoint\": " << JsonString(arguments.emitted_name) << ",\n";
    std::cout << "  \"stage\": " << JsonString(StageName(entry_point.stage)) << ",\n";
    std::cout << "  \"needsStorageBufferSizes\": "
              << (output->needs_storage_buffer_sizes ? "true" : "false") << ",\n";
    if (arguments.storage_buffer_sizes_index) {
        std::cout << "  \"storageBufferSizesIndex\": "
                  << *arguments.storage_buffer_sizes_index << ",\n";
    }
    if (arguments.immediate_index) {
        std::cout << "  \"immediateIndex\": " << *arguments.immediate_index << ",\n";
    }
    std::cout << "  \"usedStorageBufferSizes\": "
              << (used_storage_buffer_sizes ? "true" : "false") << ",\n";
    std::cout << "  \"usedImmediate\": " << (used_immediate ? "true" : "false") << ",\n";
    std::cout << "  \"bindings\": [\n";
    for (size_t index = 0; index < ordered.size(); ++index) {
        const auto& mapping = ordered[index];
        std::cout << "    {\"kind\": " << JsonString(mapping.kind)
                  << ", \"group\": " << mapping.source.group
                  << ", \"binding\": " << mapping.source.binding
                  << ", \"metalIndex\": " << mapping.index
                  << ", \"count\": " << mapping.count << "}"
                  << (index + 1 == ordered.size() ? "\n" : ",\n");
    }
    std::cout << "  ]\n}\n";
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    const auto arguments = ParseArguments(argc, argv);
    if (!arguments) {
        std::cerr << "usage: wrapper <input.wgsl> <entry-point> <emitted-name> <output.metal> "
                     "<mapping.txt> [--sized-binding-array] "
                     "[--storage-buffer-sizes-index <index>] [--immediate-index <index>] "
                     "[--force-u32-div-mod-immediate]\n";
        return 64;
    }
    tint::Initialize();
    const int result = Run(*arguments);
    tint::Shutdown();
    return result;
}
