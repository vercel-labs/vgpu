// Direct API gate for multi-entry materialization and canonical union output.

#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <variant>
#include <vector>

#include "override-materializer.h"
#include "src/tint/api/tint.h"
#include "src/tint/lang/core/ir/override.h"
#include "src/tint/lang/wgsl/reader/reader.h"

namespace {

using Configuration = vgpu::native::overrides::Configuration;
using Diagnostic = vgpu::native::overrides::Diagnostic;
using DiagnosticCode = vgpu::native::overrides::DiagnosticCode;
using F32Bits = vgpu::native::overrides::F32Bits;
using Materialization = vgpu::native::overrides::Materialization;
using PipelineStage = vgpu::native::overrides::PipelineStage;
using SelectedEntry = vgpu::native::overrides::SelectedEntry;

bool Same(const std::vector<std::string> &actual,
          const std::vector<std::string> &expected) {
  return actual == expected;
}

int Fail(std::string_view message) {
  std::cerr << message << '\n';
  return 1;
}

bool HasCode(const vgpu::native::overrides::Result &result,
             DiagnosticCode code) {
  const auto *diagnostic = std::get_if<Diagnostic>(&result);
  return diagnostic != nullptr && diagnostic->code == code &&
         diagnostic->message.size() <= 16 * 1024;
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 3) {
    return Fail("api gate requires union and dependency WGSL paths");
  }
  std::ifstream stream(argv[1], std::ios::binary);
  std::ostringstream contents;
  contents << stream.rdbuf();
  const std::string source = contents.str();
  if (source.empty()) {
    return Fail("api gate source is empty or unreadable");
  }

  tint::Source::File source_file("fixtures/multi-entry-union.wgsl", source);
  auto program = tint::wgsl::reader::Parse(&source_file, {});
  if (!program.IsValid()) {
    return Fail(program.Diagnostics().Str());
  }

  auto install_ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (install_ir_result != tint::Success) {
    return Fail(install_ir_result.Failure().reason);
  }
  auto &install_ir = install_ir_result.Get();
  if (vgpu::native::overrides::InstallValues(install_ir,
                                             {{"SHARED", uint32_t{4}}})) {
    return Fail("typed-value installer rejected an exact u32 value");
  }
  const auto wrong_install =
      vgpu::native::overrides::InstallValues(install_ir, {{"SHARED", true}});
  if (!wrong_install || wrong_install->code != DiagnosticCode::kWrongType) {
    return Fail("typed-value installer accepted a mismatched scalar type");
  }
  if (!vgpu::native::overrides::InstallValues(install_ir,
                                              {{"MISSING", uint32_t{1}}})) {
    return Fail("typed-value installer accepted an unknown name");
  }
  const auto nonfinite_install = vgpu::native::overrides::InstallValues(
      install_ir, {{"SHARED", F32Bits{.bits = 0x7f800000u}}});
  if (!nonfinite_install ||
      nonfinite_install->code != DiagnosticCode::kNonFinite) {
    return Fail("typed-value installer accepted non-finite float bits");
  }
  std::map<std::string, vgpu::native::overrides::ScalarValue> excessive_install;
  for (size_t index = 0; index < 4097; ++index) {
    excessive_install.emplace("V" + std::to_string(index), uint32_t{1});
  }
  const auto capped_install =
      vgpu::native::overrides::InstallValues(install_ir, excessive_install);
  if (!capped_install || capped_install->code != DiagnosticCode::kRequest) {
    return Fail("typed-value installer omitted its input cap");
  }

  auto atomic_ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (atomic_ir_result != tint::Success) {
    return Fail(atomic_ir_result.Failure().reason);
  }
  auto &atomic_ir = atomic_ir_result.Get();
  std::map<std::string, const tint::core::ir::Value *> initializers;
  for (auto *instruction : *atomic_ir.root_block) {
    if (auto *item = instruction->As<tint::core::ir::Override>()) {
      initializers.emplace(std::string(atomic_ir.NameOf(item).NameView()),
                           item->Initializer());
    }
  }
  const auto atomic_failure = vgpu::native::overrides::InstallValues(
      atomic_ir, {{"FIRST", uint32_t{7}}, {"SHARED", true}});
  if (!atomic_failure || atomic_failure->code != DiagnosticCode::kWrongType) {
    return Fail("typed-value installer accepted a mixed valid/invalid map");
  }
  for (auto *instruction : *atomic_ir.root_block) {
    if (auto *item = instruction->As<tint::core::ir::Override>()) {
      const std::string name(atomic_ir.NameOf(item).NameView());
      if (!initializers.contains(name) ||
          initializers.at(name) != item->Initializer()) {
        return Fail("typed-value installer mutated IR before validation ended");
      }
    }
  }

  const auto result = vgpu::native::overrides::Materialize(
      program,
      {SelectedEntry{.name = "second", .stage = PipelineStage::kCompute},
       SelectedEntry{.name = "first", .stage = PipelineStage::kCompute}},
      {Configuration{.identifier = "SHARED", .value = 4.0}});
  if (const auto *diagnostic = std::get_if<Diagnostic>(&result)) {
    return Fail(std::string(vgpu::native::overrides::DiagnosticCodeName(
                    diagnostic->code)) +
                ": " + diagnostic->message);
  }
  const auto &materialization = std::get<Materialization>(result);
  if (materialization.entries.size() != 2 ||
      materialization.entries[0].name != "second" ||
      materialization.entries[1].name != "first" ||
      materialization.entries[0].stage != PipelineStage::kCompute ||
      materialization.entries[1].stage != PipelineStage::kCompute) {
    return Fail("multi-entry stage or ordering drift");
  }
  if (!Same(materialization.entries[0].exact_override_names,
            {"SECOND", "SHARED"}) ||
      !Same(materialization.entries[1].exact_override_names,
            {"FIRST", "SHARED"}) ||
      !Same(materialization.entries[0].effective_override_names,
            {"SECOND", "SHARED"}) ||
      !Same(materialization.entries[1].effective_override_names,
            {"FIRST", "SHARED"})) {
    return Fail("multi-entry exact or effective subsets drift");
  }

  const std::vector<std::string> expected_union{"FIRST", "SECOND", "SHARED"};
  std::vector<std::string> union_names;
  for (const auto &item : materialization.overrides) {
    union_names.push_back(item.name);
    if (item.wgsl_id) {
      return Fail("auto Tint ID escaped the materializer API");
    }
  }
  if (!Same(union_names, expected_union)) {
    return Fail("program override union is not canonical");
  }

  const auto &shared = materialization.overrides[2];
  if (shared.default_result.status !=
          vgpu::native::overrides::DefaultStatus::kValue ||
      !shared.default_result.value ||
      std::get<uint32_t>(*shared.default_result.value) != 2u ||
      std::get<uint32_t>(shared.selected) != 4u) {
    return Fail("shared override record drift");
  }
  if (!materialization.entries[0].workgroup_axes ||
      !materialization.entries[1].workgroup_axes ||
      (*materialization.entries[0].workgroup_axes)[0].resolved != 6u ||
      (*materialization.entries[1].workgroup_axes)[0].resolved != 5u) {
    return Fail("multi-entry workgroup materialization drift");
  }

  if (!HasCode(
          vgpu::native::overrides::Materialize(
              program,
              {SelectedEntry{.name = "first", .stage = PipelineStage::kCompute},
               SelectedEntry{.name = "second",
                             .stage = PipelineStage::kCompute},
               SelectedEntry{.name = "third",
                             .stage = PipelineStage::kCompute}},
              {}),
          DiagnosticCode::kRequest)) {
    return Fail("selected-entry cap is not enforced by the core");
  }
  std::vector<Configuration> excessive_configuration(
      4097, Configuration{.identifier = "SHARED", .value = 4.0});
  if (!HasCode(vgpu::native::overrides::Materialize(
                   program,
                   {SelectedEntry{.name = "first",
                                  .stage = PipelineStage::kCompute}},
                   excessive_configuration),
               DiagnosticCode::kRequest)) {
    return Fail("configuration cap is not enforced by the core");
  }
  if (!HasCode(vgpu::native::overrides::Materialize(
                   program,
                   {SelectedEntry{.name = "first",
                                  .stage = PipelineStage::kCompute}},
                   {Configuration{.identifier = std::string(257, 'A'),
                                  .value = 4.0}}),
               DiagnosticCode::kRequest)) {
    return Fail("identifier cap is not enforced by the core");
  }
  if (!HasCode(vgpu::native::overrides::Materialize(
                   program,
                   {SelectedEntry{.name = "first",
                                  .stage = PipelineStage::kFragment}},
                   {}),
               DiagnosticCode::kEntry)) {
    return Fail("selected-entry stage is not cross-checked by the core");
  }

  std::ifstream dependency_stream(argv[2], std::ios::binary);
  std::ostringstream dependency_contents;
  dependency_contents << dependency_stream.rdbuf();
  const std::string dependency_source = dependency_contents.str();
  tint::Source::File dependency_file("fixtures/wide-dependencies.wgsl",
                                     dependency_source);
  auto dependency_program = tint::wgsl::reader::Parse(&dependency_file, {});
  if (!dependency_program.IsValid()) {
    return Fail(dependency_program.Diagnostics().Str());
  }
  const auto dependency_result = vgpu::native::overrides::Materialize(
      dependency_program,
      {SelectedEntry{.name = "sum", .stage = PipelineStage::kCompute}}, {});
  if (const auto *diagnostic = std::get_if<Diagnostic>(&dependency_result)) {
    return Fail(diagnostic->message);
  }
  const auto &dependency_materialization =
      std::get<Materialization>(dependency_result);
  const auto &dependency_entry = dependency_materialization.entries.front();
  if (!dependency_entry.workgroup_axes ||
      (*dependency_entry.workgroup_axes)[0].resolved != 128u ||
      (*dependency_entry.workgroup_axes)[0].override_dependencies.size() !=
          128u ||
      (*dependency_entry.workgroup_axes)[0].override_dependencies.front() !=
          "O000" ||
      (*dependency_entry.workgroup_axes)[0].override_dependencies.back() !=
          "O127") {
    return Fail("iterative dependency traversal lost wide-chain evidence");
  }

  std::cout << "passed\n";
  return 0;
}
