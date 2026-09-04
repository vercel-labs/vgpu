#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "src/tint/api/tint.h"
#include "src/tint/lang/core/ir/disassembler.h"
#include "src/tint/lang/msl/writer/printer/printer.h"
#include "src/tint/lang/msl/writer/raise/raise.h"
#include "src/tint/lang/msl/writer/writer.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"

namespace {

std::string Read(const std::filesystem::path &path) {
  std::ifstream stream(path, std::ios::binary);
  std::ostringstream out;
  out << stream.rdbuf();
  return out.str();
}

void Write(const std::filesystem::path &path, std::string_view contents) {
  std::ofstream stream(path, std::ios::binary);
  stream << contents;
  if (!stream) {
    std::cerr << "could not write " << path << "\n";
    std::exit(1);
  }
}

const char *Component(tint::inspector::ComponentType value) {
  using T = tint::inspector::ComponentType;
  switch (value) {
  case T::kF32:
    return "f32";
  case T::kU32:
    return "u32";
  case T::kI32:
    return "i32";
  case T::kF16:
    return "f16";
  case T::kUnknown:
    return "unknown";
  }
}

const char *Composition(tint::inspector::CompositionType value) {
  using T = tint::inspector::CompositionType;
  switch (value) {
  case T::kScalar:
    return "scalar";
  case T::kVec2:
    return "vec2";
  case T::kVec3:
    return "vec3";
  case T::kVec4:
    return "vec4";
  case T::kUnknown:
    return "unknown";
  }
}

const char *Interpolation(tint::inspector::InterpolationType value) {
  using T = tint::inspector::InterpolationType;
  switch (value) {
  case T::kPerspective:
    return "perspective";
  case T::kLinear:
    return "linear";
  case T::kFlat:
    return "flat";
  case T::kUnknown:
    return "unknown";
  }
}

const char *Sampling(tint::inspector::InterpolationSampling value) {
  using T = tint::inspector::InterpolationSampling;
  switch (value) {
  case T::kNone:
    return "none";
  case T::kCenter:
    return "center";
  case T::kCentroid:
    return "centroid";
  case T::kSample:
    return "sample";
  case T::kFirst:
    return "first";
  case T::kEither:
    return "either";
  case T::kUnknown:
    return "unknown";
  }
}

void Optional(std::ostream &out, std::string_view name,
              std::optional<uint32_t> value) {
  if (value) {
    out << " " << name << "=" << *value;
  }
}

void Variables(std::ostream &out, std::string_view direction,
               const std::vector<tint::inspector::StageVariable> &variables) {
  for (const auto &variable : variables) {
    out << direction << " name=" << variable.name
        << " leaf=" << variable.variable_name;
    Optional(out, "location", variable.attributes.location);
    Optional(out, "color", variable.attributes.color);
    Optional(out, "blend_src", variable.attributes.blend_src);
    out << " type=" << Composition(variable.composition_type) << "<"
        << Component(variable.component_type) << ">"
        << " interpolation=" << Interpolation(variable.interpolation_type)
        << "/" << Sampling(variable.interpolation_sampling) << "\n";
  }
}

std::string Inspect(const tint::Program &program,
                    const std::string &entry_name) {
  tint::inspector::Inspector inspector(program);
  auto entry = inspector.GetEntryPoint(entry_name);
  if (!inspector.error().empty()) {
    std::cerr << inspector.error() << "\n";
    std::exit(1);
  }

  std::ostringstream out;
  out << "entry=" << entry.name << "\n";
  Variables(out, "input", entry.input_variables);
  Variables(out, "output", entry.output_variables);
  out << "builtins"
      << " vertex_index=" << entry.vertex_index_used
      << " instance_index=" << entry.instance_index_used
      << " position_input=" << entry.frag_position_used
      << " front_facing=" << entry.front_facing_used
      << " sample_index=" << entry.sample_index_used
      << " sample_mask_input=" << entry.input_sample_mask_used
      << " frag_depth_output=" << entry.frag_depth_used
      << " sample_mask_output=" << entry.output_sample_mask_used << "\n";
  return out.str();
}

bool Require(std::string_view haystack, std::string_view needle,
             std::string_view label) {
  if (haystack.find(needle) != std::string_view::npos) {
    return true;
  }
  std::cerr << "missing " << label << ": " << needle << "\n";
  return false;
}

bool RunEntry(const std::filesystem::path &source_path,
              const std::filesystem::path &output_dir,
              const std::string &entry_name, const std::string &emitted_name) {
  const std::string source_text = Read(source_path);
  tint::Source::File source_file(source_path.string(), source_text);
  tint::wgsl::reader::Options reader_options;
  reader_options.allowed_features = tint::wgsl::AllowedFeatures::Everything();
  auto program = tint::wgsl::reader::Parse(&source_file, reader_options);
  if (!program.IsValid()) {
    std::cerr << program.Diagnostics().Str();
    return false;
  }

  const std::string inspection = Inspect(program, entry_name);
  auto ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (ir_result != tint::Success) {
    std::cerr << ir_result.Failure() << "\n";
    return false;
  }
  auto &ir = ir_result.Get();
  const std::string pre_ir = tint::core::ir::Disassembler(ir).Plain();

  tint::msl::writer::Options options;
  options.entry_point_name = entry_name;
  options.remapped_entry_point_name = emitted_name;
  auto generated = tint::msl::writer::Generate(ir, options);
  if (generated != tint::Success) {
    std::cerr << generated.Failure() << "\n";
    return false;
  }
  const std::string post_ir = tint::core::ir::Disassembler(ir).Plain();
  const std::string msl = generated->msl;

  // Exercise the public split writer seam too: Raise() exposes the backend IR
  // before Print().
  auto split_ir_result = tint::wgsl::reader::ProgramToLoweredIR(program);
  if (split_ir_result != tint::Success) {
    std::cerr << split_ir_result.Failure() << "\n";
    return false;
  }
  auto &split_ir = split_ir_result.Get();
  auto raised = tint::msl::writer::Raise(split_ir, options);
  if (raised != tint::Success) {
    std::cerr << raised.Failure() << "\n";
    return false;
  }
  const std::string raised_ir = tint::core::ir::Disassembler(split_ir).Plain();
  auto printed = tint::msl::writer::Print(split_ir, options);
  if (printed != tint::Success) {
    std::cerr << printed.Failure() << "\n";
    return false;
  }
  const std::string post_print_ir =
      tint::core::ir::Disassembler(split_ir).Plain();

  const auto prefix = output_dir / entry_name;
  Write(prefix.string() + ".inspector.txt", inspection);
  Write(prefix.string() + ".pre.ir", pre_ir);
  Write(prefix.string() + ".post.ir", post_ir);
  Write(prefix.string() + ".raised.ir", raised_ir);
  Write(prefix.string() + ".post-print.ir", post_print_ir);
  Write(prefix.string() + ".metal", msl);

  bool ok = true;
  ok &= Require(pre_ir, "%" + entry_name + " = @", "logical entry in pre-IR");
  ok &= Require(post_ir, "%" + entry_name + "_inner = func",
                "inner function in post-IR");
  ok &= Require(post_ir, "%" + entry_name + " = @", "wrapper entry in post-IR");
  ok &= Require(msl, emitted_name + "(", "remapped MSL entry name");
  if (raised_ir != post_ir) {
    std::cerr << "Raise()+Print() IR differs from Generate() IR for "
              << entry_name << "\n";
    ok = false;
  }
  if (post_print_ir != raised_ir) {
    std::cerr << "Print() changed raised IR for " << entry_name << "\n";
    ok = false;
  }
  if (printed->msl != msl) {
    std::cerr << "Raise()+Print() MSL differs from Generate() for "
              << entry_name << "\n";
    ok = false;
  }
  if (entry_name == "vertex_main") {
    ok &= Require(
        inspection,
        "input name=input.model_position leaf=model_position location=3",
        "vertex location reflection");
    ok &= Require(inspection, "vertex_index=1 instance_index=1",
                  "vertex builtin flags");
    ok &= Require(msl, "[[attribute(3)]]", "vertex MSL attribute");
    ok &= Require(msl, "[[user(locn2)]] [[centroid_no_perspective]]",
                  "vertex MSL interpolant");
    ok &= Require(msl, "[[vertex_id]]", "vertex_id MSL builtin");
    ok &= Require(msl, "[[instance_id]]", "instance_id MSL builtin");
  } else if (entry_name == "fragment_main") {
    ok &= Require(
        inspection,
        "output name=<retval>.primary leaf=primary location=0 blend_src=0",
        "blend_src 0 reflection");
    ok &= Require(
        inspection,
        "output name=<retval>.secondary leaf=secondary location=0 blend_src=1",
        "blend_src 1 reflection");
    ok &= Require(inspection, "position_input=1 front_facing=1 sample_index=1",
                  "fragment builtin flags");
    ok &= Require(msl, "[[color(0)]] [[index(0)]]", "dual-source MSL index 0");
    ok &= Require(msl, "[[color(0)]] [[index(1)]]", "dual-source MSL index 1");
    ok &= Require(msl, "[[front_facing]]", "front_facing MSL builtin");
    ok &= Require(msl, "[[sample_id]]", "sample_id MSL builtin");
    ok &= Require(msl, "[[depth(any)]]", "depth MSL builtin");
    ok &= Require(msl, "[[sample_mask]]", "sample_mask MSL builtin");
  } else if (entry_name == "scalar_fragment") {
    ok &= Require(inspection, "output name=<retval> leaf= location=3",
                  "unnamed return reflection");
    ok &= Require(post_ir, "scalar_fragment_outputs",
                  "synthetic scalar output struct");
  }

  std::cout << (ok ? "PASS " : "FAIL ") << entry_name << " -> " << emitted_name
            << "\n";
  return ok;
}

int Main(int argc, char **argv) {
  if (argc != 3) {
    std::cerr << "usage: shader-io-reflection <interfaces.wgsl> <output-dir>\n";
    return 64;
  }
  const std::filesystem::path source_path = argv[1];
  const std::filesystem::path output_dir = argv[2];
  std::filesystem::create_directories(output_dir);

  bool ok = true;
  ok &= RunEntry(source_path, output_dir, "vertex_main", "emitted_vertex");
  ok &= RunEntry(source_path, output_dir, "fragment_main", "emitted_fragment");
  ok &= RunEntry(source_path, output_dir, "fragment_single",
                 "emitted_fragment_single");
  ok &= RunEntry(source_path, output_dir, "scalar_fragment", "emitted_scalar");
  ok &= RunEntry(source_path, output_dir, "sparse_vertex",
                 "emitted_sparse_vertex");
  ok &= RunEntry(source_path, output_dir, "position_only_vertex",
                 "emitted_position_only_vertex");
  ok &= RunEntry(source_path, output_dir, "constant_color3_fragment",
                 "emitted_constant_color3_fragment");
  ok &= RunEntry(source_path, output_dir, "sparse_mrt_fragment",
                 "emitted_sparse_mrt_fragment");
  ok &= RunEntry(source_path, output_dir, "dual_constant_fragment",
                 "emitted_dual_constant_fragment");
  ok &= RunEntry(source_path, output_dir, "missing_interstage_fragment",
                 "emitted_missing_interstage_fragment");
  ok &= RunEntry(source_path, output_dir, "interpolation_mismatch_fragment",
                 "emitted_interpolation_mismatch_fragment");
  ok &= RunEntry(source_path, output_dir, "type_mismatch_fragment",
                 "emitted_type_mismatch_fragment");
  return ok ? 0 : 1;
}

} // namespace

int main(int argc, char **argv) {
  tint::Initialize();
  const int result = Main(argc, argv);
  tint::Shutdown();
  return result;
}
