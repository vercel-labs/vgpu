// Focused proof that uniform_buffer_standard_layout is an explicit Tint environment feature and
// that Tint's resolved semantic types expose the layout consumed by host packers.

#include <fstream>
#include <iostream>
#include <iterator>
#include <string>

#include "src/tint/api/tint.h"
#include "src/tint/lang/core/type/array.h"
#include "src/tint/lang/core/type/struct.h"
#include "src/tint/lang/wgsl/reader/reader.h"

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "usage: tint-feature-gate <input.wgsl> <disabled|enabled>\n";
        return 64;
    }
    const std::string feature_state = argv[2];
    if (feature_state != "disabled" && feature_state != "enabled") {
        std::cerr << "feature state must be disabled or enabled\n";
        return 64;
    }

    std::ifstream stream(argv[1], std::ios::binary);
    if (!stream) {
        std::cerr << "could not read input\n";
        return 1;
    }
    const std::string source_text((std::istreambuf_iterator<char>(stream)),
                                  std::istreambuf_iterator<char>());

    tint::Initialize();
    tint::Source::File source(argv[1], source_text);
    tint::wgsl::reader::Options options;
    if (feature_state == "enabled") {
        options.allowed_features.features.insert(
            tint::wgsl::LanguageFeature::kUniformBufferStandardLayout);
    }

    auto program = tint::wgsl::reader::Parse(&source, options);
    if (!program.IsValid()) {
        std::cerr << program.Diagnostics().Str();
        tint::Shutdown();
        return 1;
    }

    for (const auto* type : program.Types()) {
        const auto* structure = type->As<tint::core::type::Struct>();
        if (!structure || structure->FriendlyName() != "Params") {
            continue;
        }
        std::cout << "struct=" << structure->FriendlyName()
                  << " align=" << structure->Align()
                  << " size=" << structure->Size() << '\n';
        for (const auto* member : structure->Members()) {
            std::cout << "member=" << member->Name().Name()
                      << " offset=" << member->Offset()
                      << " align=" << member->Align()
                      << " size=" << member->Size();
            if (const auto* array = member->Type()->As<tint::core::type::Array>()) {
                std::cout << " stride=" << array->ImplicitStride();
            }
            std::cout << '\n';
        }
    }

    tint::Shutdown();
    return 0;
}
