#ifndef VGPU_NATIVE_C1_COMPILER_PROTOCOL_REQUEST_H_
#define VGPU_NATIVE_C1_COMPILER_PROTOCOL_REQUEST_H_

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <variant>
#include <vector>

#include "src/tint/api/common/bindings.h"

namespace vgpu::native {

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

struct InterfaceType {
  std::string scalar;
  uint32_t width = 0;

  bool operator==(const InterfaceType &) const = default;
};

struct InterfaceInterpolation {
  std::string type;
  std::string sampling;

  bool operator==(const InterfaceInterpolation &) const = default;
};

struct InterfaceValue {
  InterfaceType type;
  bool invariant = false;
  std::optional<uint32_t> location;
  std::optional<std::string> builtin;
  std::optional<InterfaceInterpolation> interpolation;
  std::optional<uint32_t> blend_source;

  bool operator==(const InterfaceValue &) const = default;
};

struct SemanticInterface {
  std::string kind;
  std::vector<InterfaceValue> inputs;
  std::vector<InterfaceValue> outputs;

  bool operator==(const SemanticInterface &) const = default;
};

struct CompilerRequest {
  std::string source_text;
  std::string source_name;
  std::string stage;
  std::string entry_point;
  std::string emitted_name;
  SemanticInterface semantic_interface;
  std::set<std::string> features;
  std::map<std::string, OverrideValue> overrides;
  std::vector<Mapping> mappings;
};

struct RequestIdentity {
  std::string domain;
  std::string sha256;
};

struct EntryInventoryRequest {
  std::string source_text;
  std::string source_name;
  std::set<std::string> features;
  RequestIdentity identity;
};

struct SelectedEntryPoint {
  std::string stage;
  std::string wgsl;
};

struct ConfiguredOverride {
  std::string name;
  std::variant<bool, double> value;
};

struct SemanticExtractionRequest {
  std::string source_text;
  std::string source_name;
  std::set<std::string> features;
  std::vector<SelectedEntryPoint> entry_points;
  std::vector<ConfiguredOverride> override_configuration;
  RequestIdentity identity;
};

using WorkerRequest =
    std::variant<CompilerRequest, EntryInventoryRequest,
                 SemanticExtractionRequest>;

enum class RequestOperation {
  kCompiler,
  kEntryInventory,
  kSemanticExtraction,
};

} // namespace vgpu::native

#endif // VGPU_NATIVE_C1_COMPILER_PROTOCOL_REQUEST_H_
