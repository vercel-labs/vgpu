#ifndef VGPU_NATIVE_C1_COMPILER_PROTOCOL_REQUEST_H_
#define VGPU_NATIVE_C1_COMPILER_PROTOCOL_REQUEST_H_

#include <cstdint>
#include <map>
#include <set>
#include <string>
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

struct CompilerRequest {
  std::string source_text;
  std::string source_name;
  std::string stage;
  std::string entry_point;
  std::string emitted_name;
  std::set<std::string> features;
  std::map<std::string, OverrideValue> overrides;
  std::vector<Mapping> mappings;
};

} // namespace vgpu::native

#endif // VGPU_NATIVE_C1_COMPILER_PROTOCOL_REQUEST_H_
