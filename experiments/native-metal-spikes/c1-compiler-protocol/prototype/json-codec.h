#ifndef VGPU_NATIVE_C1_COMPILER_PROTOCOL_JSON_CODEC_H_
#define VGPU_NATIVE_C1_COMPILER_PROTOCOL_JSON_CODEC_H_

#include <cstddef>
#include <istream>
#include <optional>
#include <string>

#include "request.h"

namespace vgpu::native {

inline constexpr size_t kMaxRequestBytes = 128U * 1024U * 1024U;
inline constexpr size_t kMaxSourceBytes = 16U * 1024U * 1024U;
inline constexpr size_t kMaxMslBytes = 64U * 1024U * 1024U;
inline constexpr size_t kMaxResponseBytes = 160U * 1024U * 1024U;
inline constexpr size_t kMaxJsonDepth = 64U;

enum class RequestFailureKind {
  kNone,
  kFraming,
  kIo,
  kProtocol,
};

struct DecodedRequest {
  std::optional<CompilerRequest> value;
  RequestFailureKind failure = RequestFailureKind::kNone;
  std::string error;
};

// Reads one UTF-8 JSON value through EOF, then validates and decodes the full
// v1 request. Syntax/framing errors are deliberately distinct from a decoded
// JSON value that does not implement the protocol.
DecodedRequest ReadRequest(std::istream &input);

} // namespace vgpu::native

#endif // VGPU_NATIVE_C1_COMPILER_PROTOCOL_JSON_CODEC_H_
