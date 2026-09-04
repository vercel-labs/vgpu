#include "json-codec.h"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <iomanip>
#include <limits>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include "json/json.h"

namespace vgpu::native {
namespace {

constexpr std::string_view kCompilerContract = "vgpu-native-tint-compiler/v1";
constexpr std::string_view kEntryInventoryContract =
    "vgpu-native-tint-entry-inventory/v1";
constexpr std::string_view kEntryInventoryRequestIdentityDomain =
    "vgpu-native-tint-entry-inventory-request-bytes/v1";
constexpr std::string_view kOriginMapContract = "vgpu-native-origin-map/v1";
constexpr std::string_view kBindingModel = "vgpu-metal-binding-slots-v1";
constexpr std::string_view kStorageSizeModel =
    "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v1";
constexpr size_t kMaxOriginSources = 4096;
constexpr size_t kMaxOriginSegments = 65536;
constexpr size_t kMaxOverrides = 4096;
constexpr size_t kMaxLanguageFeatures = 5;
constexpr size_t kMaxBindings = 65536;
constexpr size_t kMaxInterfaceValues = 64;
constexpr size_t kMaxJsonComplexityUnits = 262144;
constexpr uint64_t kMaxSafeInteger = 9007199254740991ULL;

struct Utf8Info {
  bool valid = false;
  size_t code_points = 0;
};

Utf8Info InspectUtf8(std::string_view value) {
  size_t index = 0;
  size_t code_points = 0;
  const auto continuation = [&](size_t offset) {
    return offset < value.size() &&
           (static_cast<unsigned char>(value[offset]) & 0xc0U) == 0x80U;
  };
  while (index < value.size()) {
    const auto first = static_cast<unsigned char>(value[index]);
    size_t length = 0;
    if (first <= 0x7fU) {
      length = 1;
    } else if (first >= 0xc2U && first <= 0xdfU && continuation(index + 1)) {
      length = 2;
    } else if (first == 0xe0U && index + 2 < value.size() &&
               static_cast<unsigned char>(value[index + 1]) >= 0xa0U &&
               static_cast<unsigned char>(value[index + 1]) <= 0xbfU &&
               continuation(index + 2)) {
      length = 3;
    } else if (((first >= 0xe1U && first <= 0xecU) ||
                (first >= 0xeeU && first <= 0xefU)) &&
               continuation(index + 1) && continuation(index + 2)) {
      length = 3;
    } else if (first == 0xedU && index + 2 < value.size() &&
               static_cast<unsigned char>(value[index + 1]) >= 0x80U &&
               static_cast<unsigned char>(value[index + 1]) <= 0x9fU &&
               continuation(index + 2)) {
      length = 3;
    } else if (first == 0xf0U && index + 3 < value.size() &&
               static_cast<unsigned char>(value[index + 1]) >= 0x90U &&
               static_cast<unsigned char>(value[index + 1]) <= 0xbfU &&
               continuation(index + 2) && continuation(index + 3)) {
      length = 4;
    } else if (first >= 0xf1U && first <= 0xf3U && continuation(index + 1) &&
               continuation(index + 2) && continuation(index + 3)) {
      length = 4;
    } else if (first == 0xf4U && index + 3 < value.size() &&
               static_cast<unsigned char>(value[index + 1]) >= 0x80U &&
               static_cast<unsigned char>(value[index + 1]) <= 0x8fU &&
               continuation(index + 2) && continuation(index + 3)) {
      length = 4;
    } else {
      return {};
    }
    index += length;
    ++code_points;
  }
  return {.valid = true, .code_points = code_points};
}

std::optional<uint16_t> ParseHexQuad(std::string_view text, size_t offset) {
  if (offset + 4 > text.size()) {
    return std::nullopt;
  }
  uint16_t result = 0;
  for (size_t index = 0; index < 4; ++index) {
    const unsigned char character = text[offset + index];
    uint16_t digit = 0;
    if (character >= '0' && character <= '9') {
      digit = static_cast<uint16_t>(character - '0');
    } else if (character >= 'a' && character <= 'f') {
      digit = static_cast<uint16_t>(character - 'a' + 10);
    } else if (character >= 'A' && character <= 'F') {
      digit = static_cast<uint16_t>(character - 'A' + 10);
    } else {
      return std::nullopt;
    }
    result = static_cast<uint16_t>((result << 4U) | digit);
  }
  return result;
}

// JsonCpp 1.9.8 accepts a high-surrogate escape followed by a non-low
// surrogate. This bounded lexical pass validates UTF-16 escapes, number
// grammar, container depth, and allocation units; JsonCpp remains the JSON
// parser and validates the surrounding grammar.
bool IsJsonWhitespace(unsigned char character) {
  return character == ' ' || character == '\t' || character == '\n' ||
         character == '\r';
}

bool IsJsonValueDelimiter(std::string_view text, size_t index) {
  if (index == text.size()) {
    return true;
  }
  const unsigned char character = text[index];
  return IsJsonWhitespace(character) || character == ',' || character == ']' ||
         character == '}';
}

bool HasValidJsonLexemes(std::string_view text) {
  bool in_string = false;
  // One unit per JSON value plus one per object-member name. This equals the
  // recursive metric the Node caller can compute from its typed value without
  // duplicating this lexical scanner.
  size_t complexity_units = 0;
  std::vector<unsigned char> containers;
  for (size_t index = 0; index < text.size(); ++index) {
    const unsigned char character = text[index];
    if (!in_string) {
      if (character == '"') {
        in_string = true;
        if (++complexity_units > kMaxJsonComplexityUnits) {
          return false;
        }
      } else if (character == '{' || character == '[') {
        containers.push_back(character);
        if (containers.size() > kMaxJsonDepth ||
            ++complexity_units > kMaxJsonComplexityUnits) {
          return false;
        }
      } else if (character == '}' || character == ']') {
        const unsigned char expected = character == '}' ? '{' : '[';
        if (containers.empty() || containers.back() != expected) {
          return false;
        }
        containers.pop_back();
      } else if (character == ',' || character == ':') {
        continue;
      } else if (IsJsonWhitespace(character)) {
        continue;
      } else if (character == 't' || character == 'f' || character == 'n') {
        const std::string_view literal = character == 't'   ? "true"
                                         : character == 'f' ? "false"
                                                            : "null";
        if (text.substr(index, literal.size()) != literal ||
            !IsJsonValueDelimiter(text, index + literal.size()) ||
            ++complexity_units > kMaxJsonComplexityUnits) {
          return false;
        }
        index += literal.size() - 1;
      } else if (character == '-' || (character >= '0' && character <= '9')) {
        size_t end = index;
        if (text[end] == '-') {
          ++end;
          if (end == text.size()) {
            return false;
          }
        }
        if (text[end] == '0') {
          ++end;
          if (end < text.size() && text[end] >= '0' && text[end] <= '9') {
            return false;
          }
        } else if (text[end] >= '1' && text[end] <= '9') {
          do {
            ++end;
          } while (end < text.size() && text[end] >= '0' && text[end] <= '9');
        } else {
          return false;
        }
        if (end < text.size() && text[end] == '.') {
          ++end;
          const size_t fraction_start = end;
          while (end < text.size() && text[end] >= '0' && text[end] <= '9') {
            ++end;
          }
          if (end == fraction_start) {
            return false;
          }
        }
        if (end < text.size() && (text[end] == 'e' || text[end] == 'E')) {
          ++end;
          if (end < text.size() && (text[end] == '+' || text[end] == '-')) {
            ++end;
          }
          const size_t exponent_start = end;
          while (end < text.size() && text[end] >= '0' && text[end] <= '9') {
            ++end;
          }
          if (end == exponent_start) {
            return false;
          }
        }
        if (!IsJsonValueDelimiter(text, end) ||
            ++complexity_units > kMaxJsonComplexityUnits) {
          return false;
        }
        index = end - 1;
      } else {
        return false;
      }
      continue;
    }
    if (character == '"') {
      in_string = false;
      continue;
    }
    if (character < 0x20U) {
      return false;
    }
    if (character != '\\') {
      continue;
    }
    if (++index >= text.size()) {
      return false;
    }
    const unsigned char escaped = text[index];
    if (escaped == '"' || escaped == '\\' || escaped == '/' || escaped == 'b' ||
        escaped == 'f' || escaped == 'n' || escaped == 'r' || escaped == 't') {
      continue;
    }
    if (escaped != 'u') {
      return false;
    }
    const auto first = ParseHexQuad(text, index + 1);
    if (!first) {
      return false;
    }
    index += 4;
    if (*first >= 0xdc00U && *first <= 0xdfffU) {
      return false;
    }
    if (*first >= 0xd800U && *first <= 0xdbffU) {
      if (index + 6 >= text.size() || text[index + 1] != '\\' ||
          text[index + 2] != 'u') {
        return false;
      }
      const auto second = ParseHexQuad(text, index + 3);
      if (!second || *second < 0xdc00U || *second > 0xdfffU) {
        return false;
      }
      index += 6;
    }
  }
  return !in_string && containers.empty();
}

bool ValidateDecodedValues(const Json::Value &value) {
  if (value.isString() && !InspectUtf8(value.asString()).valid) {
    return false;
  }
  if (value.isDouble() && !std::isfinite(value.asDouble())) {
    return false;
  }
  if (value.isArray()) {
    for (const auto &item : value) {
      if (!ValidateDecodedValues(item)) {
        return false;
      }
    }
  } else if (value.isObject()) {
    for (const auto &name : value.getMemberNames()) {
      if (!InspectUtf8(name).valid || !ValidateDecodedValues(value[name])) {
        return false;
      }
    }
  }
  return true;
}

bool HasExactMembers(const Json::Value &value,
                     std::initializer_list<std::string_view> expected) {
  if (!value.isObject() || value.size() != expected.size()) {
    return false;
  }
  return std::all_of(expected.begin(), expected.end(), [&](const auto name) {
    return value.isMember(std::string(name));
  });
}

bool HasAllowedMembers(
    const Json::Value &value,
    std::initializer_list<std::string_view> required,
    std::initializer_list<std::string_view> optional = {}) {
  if (!value.isObject()) {
    return false;
  }
  for (const auto name : required) {
    if (!value.isMember(std::string(name))) {
      return false;
    }
  }
  for (const auto &name : value.getMemberNames()) {
    const auto allowed = [&](std::string_view candidate) {
      return candidate == name;
    };
    if (std::none_of(required.begin(), required.end(), allowed) &&
        std::none_of(optional.begin(), optional.end(), allowed)) {
      return false;
    }
  }
  return true;
}

std::optional<uint64_t> ReadUnsignedInteger(const Json::Value &value,
                                            uint64_t maximum) {
  uint64_t parsed = 0;
  if (value.isUInt64()) {
    parsed = value.asUInt64();
  } else if (value.isInt64()) {
    const auto signed_value = value.asInt64();
    if (signed_value < 0) {
      return std::nullopt;
    }
    parsed = static_cast<uint64_t>(signed_value);
  } else if (value.isDouble()) {
    const double number = value.asDouble();
    if (!std::isfinite(number) || number < 0 || std::trunc(number) != number ||
        number > static_cast<double>(maximum)) {
      return std::nullopt;
    }
    parsed = static_cast<uint64_t>(number);
  } else {
    return std::nullopt;
  }
  return parsed <= maximum ? std::optional<uint64_t>(parsed) : std::nullopt;
}

std::optional<int64_t> ReadSignedInteger(const Json::Value &value,
                                         int64_t minimum, int64_t maximum) {
  int64_t parsed = 0;
  if (value.isInt64()) {
    parsed = value.asInt64();
  } else if (value.isUInt64()) {
    const auto unsigned_value = value.asUInt64();
    if (unsigned_value > static_cast<uint64_t>(maximum)) {
      return std::nullopt;
    }
    parsed = static_cast<int64_t>(unsigned_value);
  } else if (value.isDouble()) {
    const double number = value.asDouble();
    if (!std::isfinite(number) || std::trunc(number) != number ||
        number < static_cast<double>(minimum) ||
        number > static_cast<double>(maximum)) {
      return std::nullopt;
    }
    parsed = static_cast<int64_t>(number);
  } else {
    return std::nullopt;
  }
  return parsed >= minimum && parsed <= maximum ? std::optional<int64_t>(parsed)
                                                : std::nullopt;
}

bool IsLowerHex(std::string_view value, size_t length) {
  return value.size() == length &&
         std::all_of(value.begin(), value.end(), [](unsigned char character) {
           return (character >= '0' && character <= '9') ||
                  (character >= 'a' && character <= 'f');
         });
}

std::optional<uint64_t> ParseHex(std::string_view value) {
  uint64_t parsed = 0;
  const auto result =
      std::from_chars(value.data(), value.data() + value.size(), parsed, 16);
  if (result.ec != std::errc{} || result.ptr != value.data() + value.size()) {
    return std::nullopt;
  }
  return parsed;
}

bool IsAsciiIdentifier(std::string_view value, size_t maximum) {
  if (value.empty() || value.size() > maximum ||
      !((value[0] >= 'A' && value[0] <= 'Z') ||
        (value[0] >= 'a' && value[0] <= 'z') || value[0] == '_')) {
    return false;
  }
  return std::all_of(value.begin() + 1, value.end(), [](unsigned char value) {
    return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') ||
           (value >= '0' && value <= '9') || value == '_';
  });
}

bool IsEmittedIdentifier(std::string_view value) {
  constexpr std::string_view kPrefix = "vgpu_";
  if (!value.starts_with(kPrefix) || value.size() <= kPrefix.size() ||
      value.size() > 256) {
    return false;
  }
  return std::all_of(value.begin() + static_cast<ptrdiff_t>(kPrefix.size()),
                     value.end(), [](unsigned char character) {
                       return (character >= 'A' && character <= 'Z') ||
                              (character >= 'a' && character <= 'z') ||
                              (character >= '0' && character <= '9') ||
                              character == '_';
                     });
}

bool IsAsciiLetter(unsigned char value) {
  return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
}

bool HasScheme(std::string_view value) {
  if (value.empty() || !IsAsciiLetter(value[0])) {
    return false;
  }
  for (size_t index = 1; index < value.size(); ++index) {
    const unsigned char character = value[index];
    if (character == ':') {
      return true;
    }
    if (!(IsAsciiLetter(character) || (character >= '0' && character <= '9') ||
          character == '+' || character == '.' || character == '-')) {
      return false;
    }
  }
  return false;
}

bool HasForbiddenIdentityCharacter(std::string_view value) {
  return std::any_of(value.begin(), value.end(), [](unsigned char character) {
    return character == '\\' || character < 0x20U || character == 0x7fU;
  });
}

bool IsRelativeVirtualPath(std::string_view value) {
  const auto info = InspectUtf8(value);
  if (!info.valid || info.code_points == 0 || info.code_points > 4096 ||
      value.starts_with('/') || HasScheme(value) ||
      (value.size() >= 2 && IsAsciiLetter(value[0]) && value[1] == ':') ||
      HasForbiddenIdentityCharacter(value)) {
    return false;
  }
  size_t start = 0;
  while (start <= value.size()) {
    const size_t end = value.find('/', start);
    const auto component =
        value.substr(start, end == std::string_view::npos ? value.size() - start
                                                          : end - start);
    if (component.empty() || component == "." || component == "..") {
      return false;
    }
    if (end == std::string_view::npos) {
      break;
    }
    start = end + 1;
  }
  return true;
}

bool IsLogicalInput(std::string_view value) {
  const auto info = InspectUtf8(value);
  return info.valid && info.code_points > 0 && info.code_points <= 1024 &&
         !value.starts_with('/') && !HasScheme(value) &&
         !HasForbiddenIdentityCharacter(value);
}

std::vector<uint16_t> Utf16CodeUnits(std::string_view value) {
  std::vector<uint16_t> result;
  result.reserve(value.size());
  for (size_t index = 0; index < value.size();) {
    const unsigned char first = value[index];
    uint32_t point = 0;
    size_t length = 1;
    if (first <= 0x7fU) {
      point = first;
    } else if (first <= 0xdfU) {
      point = ((first & 0x1fU) << 6U) |
              (static_cast<unsigned char>(value[index + 1]) & 0x3fU);
      length = 2;
    } else if (first <= 0xefU) {
      point = ((first & 0x0fU) << 12U) |
              ((static_cast<unsigned char>(value[index + 1]) & 0x3fU) << 6U) |
              (static_cast<unsigned char>(value[index + 2]) & 0x3fU);
      length = 3;
    } else {
      point = ((first & 0x07U) << 18U) |
              ((static_cast<unsigned char>(value[index + 1]) & 0x3fU) << 12U) |
              ((static_cast<unsigned char>(value[index + 2]) & 0x3fU) << 6U) |
              (static_cast<unsigned char>(value[index + 3]) & 0x3fU);
      length = 4;
    }
    if (point <= 0xffffU) {
      result.push_back(static_cast<uint16_t>(point));
    } else {
      point -= 0x10000U;
      result.push_back(static_cast<uint16_t>(0xd800U + (point >> 10U)));
      result.push_back(static_cast<uint16_t>(0xdc00U + (point & 0x3ffU)));
    }
    index += length;
  }
  return result;
}

bool Utf16Less(std::string_view left, std::string_view right) {
  return Utf16CodeUnits(left) < Utf16CodeUnits(right);
}

bool IsUtf8Boundary(std::string_view value, uint64_t offset) {
  if (offset > value.size()) {
    return false;
  }
  return offset == 0 || offset == value.size() ||
         (static_cast<unsigned char>(value[static_cast<size_t>(offset)]) &
          0xc0U) != 0x80U;
}

class Sha256 final {
public:
  Sha256()
      : state_{0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
               0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U} {}

  void Update(std::string_view input) {
    bit_length_ += static_cast<uint64_t>(input.size()) * 8U;
    for (const unsigned char byte : input) {
      buffer_[buffer_size_++] = byte;
      if (buffer_size_ == buffer_.size()) {
        Transform(buffer_.data());
        buffer_size_ = 0;
      }
    }
  }

  std::string Finish() {
    buffer_[buffer_size_++] = 0x80U;
    if (buffer_size_ > 56) {
      std::fill(buffer_.begin() + static_cast<ptrdiff_t>(buffer_size_),
                buffer_.end(), 0);
      Transform(buffer_.data());
      buffer_size_ = 0;
    }
    std::fill(buffer_.begin() + static_cast<ptrdiff_t>(buffer_size_),
              buffer_.begin() + 56, 0);
    for (size_t index = 0; index < 8; ++index) {
      buffer_[63 - index] =
          static_cast<unsigned char>(bit_length_ >> (index * 8U));
    }
    Transform(buffer_.data());

    std::ostringstream output;
    output << std::hex << std::setfill('0');
    for (const uint32_t word : state_) {
      output << std::setw(8) << word;
    }
    return output.str();
  }

private:
  void Transform(const unsigned char *block) {
    static constexpr std::array<uint32_t, 64> kRoundConstants{
        0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU,
        0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U, 0xd807aa98U, 0x12835b01U,
        0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U,
        0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
        0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U,
        0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U,
        0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
        0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
        0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U,
        0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U, 0x1e376c08U,
        0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU,
        0x682e6ff3U, 0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
        0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U};
    std::array<uint32_t, 64> words{};
    for (size_t index = 0; index < 16; ++index) {
      const size_t offset = index * 4;
      words[index] = (static_cast<uint32_t>(block[offset]) << 24U) |
                     (static_cast<uint32_t>(block[offset + 1]) << 16U) |
                     (static_cast<uint32_t>(block[offset + 2]) << 8U) |
                     static_cast<uint32_t>(block[offset + 3]);
    }
    for (size_t index = 16; index < words.size(); ++index) {
      const uint32_t s0 = std::rotr(words[index - 15], 7) ^
                          std::rotr(words[index - 15], 18) ^
                          (words[index - 15] >> 3U);
      const uint32_t s1 = std::rotr(words[index - 2], 17) ^
                          std::rotr(words[index - 2], 19) ^
                          (words[index - 2] >> 10U);
      words[index] = words[index - 16] + s0 + words[index - 7] + s1;
    }
    uint32_t a = state_[0];
    uint32_t b = state_[1];
    uint32_t c = state_[2];
    uint32_t d = state_[3];
    uint32_t e = state_[4];
    uint32_t f = state_[5];
    uint32_t g = state_[6];
    uint32_t h = state_[7];
    for (size_t index = 0; index < words.size(); ++index) {
      const uint32_t sum1 =
          std::rotr(e, 6) ^ std::rotr(e, 11) ^ std::rotr(e, 25);
      const uint32_t choice = (e & f) ^ (~e & g);
      const uint32_t temporary1 =
          h + sum1 + choice + kRoundConstants[index] + words[index];
      const uint32_t sum0 =
          std::rotr(a, 2) ^ std::rotr(a, 13) ^ std::rotr(a, 22);
      const uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const uint32_t temporary2 = sum0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temporary1;
      d = c;
      c = b;
      b = a;
      a = temporary1 + temporary2;
    }
    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
  }

  std::array<uint32_t, 8> state_;
  std::array<unsigned char, 64> buffer_{};
  size_t buffer_size_ = 0;
  uint64_t bit_length_ = 0;
};

std::string Sha256Hex(std::string_view value) {
  Sha256 hash;
  hash.Update(value);
  return hash.Finish();
}

std::string CanonicalJsonString(std::string_view value) {
  constexpr char kHex[] = "0123456789abcdef";
  std::string result;
  result.reserve(value.size() + 2);
  result.push_back('"');
  for (const unsigned char character : value) {
    switch (character) {
    case '\\':
      result.append("\\\\");
      break;
    case '"':
      result.append("\\\"");
      break;
    case '\b':
      result.append("\\b");
      break;
    case '\f':
      result.append("\\f");
      break;
    case '\n':
      result.append("\\n");
      break;
    case '\r':
      result.append("\\r");
      break;
    case '\t':
      result.append("\\t");
      break;
    default:
      if (character < 0x20U) {
        result.append("\\u00");
        result.push_back(kHex[character >> 4U]);
        result.push_back(kHex[character & 0x0fU]);
      } else {
        result.push_back(static_cast<char>(character));
      }
      break;
    }
  }
  result.push_back('"');
  return result;
}

// Mirrors deterministicStringify(originMap) in the inventory adapter. All
// object keys are fixed by origin-map-v1 and emitted in UTF-16 lexical order.
// Values are written only after DecodeOriginMap() has accepted their exact
// types.
std::string CanonicalOriginMap(const Json::Value &value) {
  std::ostringstream output;
  output << "{\"contractId\":"
         << CanonicalJsonString(value["contractId"].asString())
         << ",\"generatedSource\":{\"sha256\":"
         << CanonicalJsonString(value["generatedSource"]["sha256"].asString())
         << ",\"virtualPath\":"
         << CanonicalJsonString(
                value["generatedSource"]["virtualPath"].asString())
         << "},\"schemaVersion\":" << value["schemaVersion"].asUInt64()
         << ",\"segments\":[";
  const auto &segments = value["segments"];
  for (Json::ArrayIndex index = 0; index < segments.size(); ++index) {
    const auto &segment = segments[index];
    if (index > 0) {
      output << ',';
    }
    output << "{\"generated\":{\"endByte\":"
           << segment["generated"]["endByte"].asUInt64()
           << ",\"startByte\":"
           << segment["generated"]["startByte"].asUInt64()
           << "},\"origin\":{\"input\":"
           << CanonicalJsonString(segment["origin"]["input"].asString())
           << "},\"precision\":"
           << CanonicalJsonString(segment["precision"].asString()) << '}';
  }
  output << "],\"sources\":[";
  const auto &sources = value["sources"];
  for (Json::ArrayIndex index = 0; index < sources.size(); ++index) {
    const auto &source = sources[index];
    if (index > 0) {
      output << ',';
    }
    output << "{\"input\":"
           << CanonicalJsonString(source["input"].asString())
           << ",\"sha256\":"
           << CanonicalJsonString(source["sha256"].asString()) << '}';
  }
  output << "]}";
  return output.str();
}

RequestIdentity EntryInventoryRequestIdentity(std::string_view request_bytes) {
  Sha256 hash;
  hash.Update(kEntryInventoryRequestIdentityDomain);
  hash.Update(std::string_view("\0", 1));
  hash.Update(request_bytes);
  return RequestIdentity{
      .domain = std::string(kEntryInventoryRequestIdentityDomain),
      .sha256 = hash.Finish(),
  };
}

class Decoder final {
public:
  std::optional<CompilerRequest> DecodeCompiler(const Json::Value &root) {
    if (!HasExactMembers(root, {"schemaVersion", "contractId", "source",
                                "originMap", "entryPoint",
                                "semanticInterface", "overrides",
                                "languageFeatures", "metal"})) {
      return Reject("request has missing or unknown top-level fields");
    }
    const auto schema_version = ReadUnsignedInteger(root["schemaVersion"], 1);
    if (!schema_version || *schema_version != 1 ||
        !root["contractId"].isString() ||
        root["contractId"].asString() != kCompilerContract) {
      return Reject("request selects an unsupported compiler contract");
    }

    CompilerRequest request;
    std::string source_hash;
    if (!DecodeSource(root["source"], request, source_hash) ||
        !DecodeOriginMap(root["originMap"], request.source_name, source_hash,
                         request.source_text) ||
        !DecodeEntryPoint(root["entryPoint"], request) ||
        !DecodeOverrides(root["overrides"], request) ||
        !DecodeFeatures(root["languageFeatures"], request) ||
        !DecodeSemanticInterface(root["semanticInterface"], request) ||
        !DecodeMetal(root["metal"], request)) {
      return std::nullopt;
    }
    return request;
  }

  std::optional<EntryInventoryRequest>
  DecodeEntryInventory(const Json::Value &root,
                       const RequestIdentity &identity) {
    if (!HasExactMembers(root, {"schemaVersion", "contractId", "source",
                                "originMap", "originMapSha256",
                                "languageFeatures"})) {
      return Reject<EntryInventoryRequest>(
          "entry inventory request has missing or unknown top-level fields");
    }
    const auto schema_version = ReadUnsignedInteger(root["schemaVersion"], 1);
    if (!schema_version || *schema_version != 1 ||
        !root["contractId"].isString() ||
        root["contractId"].asString() != kEntryInventoryContract) {
      return Reject<EntryInventoryRequest>(
          "request selects an unsupported entry inventory contract");
    }

    EntryInventoryRequest request;
    request.identity = identity;
    std::string source_hash;
    if (!DecodeSource(root["source"], request, source_hash) ||
        !DecodeOriginMap(root["originMap"], request.source_name, source_hash,
                         request.source_text)) {
      return std::nullopt;
    }
    if (request.source_text.find('\0') != std::string::npos) {
      return Reject<EntryInventoryRequest>(
          "entry inventory source text contains a NUL byte");
    }
    if (!root["originMapSha256"].isString() ||
        !IsLowerHex(root["originMapSha256"].asString(), 64) ||
        Sha256Hex(CanonicalOriginMap(root["originMap"])) !=
            root["originMapSha256"].asString()) {
      return Reject<EntryInventoryRequest>(
          "origin map hash does not match its canonical v1 JSON");
    }
    if (!DecodeFeatures(root["languageFeatures"], request)) {
      return std::nullopt;
    }
    return request;
  }

  const std::string &error() const { return error_; }

private:
  template <typename T = CompilerRequest>
  std::optional<T> Reject(std::string message) {
    if (error_.empty()) {
      error_ = std::move(message);
    }
    return std::nullopt;
  }

  bool Fail(std::string message) {
    Reject(std::move(message));
    return false;
  }

  template <typename Request>
  bool DecodeSource(const Json::Value &value, Request &request,
                    std::string &source_hash) {
    if (!HasExactMembers(value, {"virtualPath", "sha256", "text"}) ||
        !value["virtualPath"].isString() || !value["sha256"].isString() ||
        !value["text"].isString()) {
      return Fail("source does not implement the v1 shape");
    }
    request.source_name = value["virtualPath"].asString();
    source_hash = value["sha256"].asString();
    request.source_text = value["text"].asString();
    const auto source_info = InspectUtf8(request.source_text);
    if (!IsRelativeVirtualPath(request.source_name)) {
      return Fail("source virtual path is not a relative POSIX path");
    }
    if (!IsLowerHex(source_hash, 64)) {
      return Fail("source hash is not lowercase SHA-256");
    }
    if (!source_info.valid || source_info.code_points == 0 ||
        request.source_text.size() > kMaxSourceBytes) {
      return Fail("source text is empty or exceeds the UTF-8 byte limit");
    }
    if (Sha256Hex(request.source_text) != source_hash) {
      return Fail("source hash does not match UTF-8 text");
    }
    return true;
  }

  bool DecodeOriginMap(const Json::Value &value,
                       const std::string &virtual_path,
                       const std::string &source_hash,
                       const std::string &source_text) {
    if (!HasExactMembers(value, {"schemaVersion", "contractId",
                                 "generatedSource", "sources", "segments"})) {
      return Fail("origin map has missing or unknown fields");
    }
    const auto version = ReadUnsignedInteger(value["schemaVersion"], 1);
    if (!version || *version != 1 || !value["contractId"].isString() ||
        value["contractId"].asString() != kOriginMapContract) {
      return Fail("origin map selects an unsupported contract");
    }
    const auto &generated = value["generatedSource"];
    if (!HasExactMembers(generated, {"virtualPath", "sha256"}) ||
        !generated["virtualPath"].isString() ||
        !generated["sha256"].isString() ||
        generated["virtualPath"].asString() != virtual_path ||
        generated["sha256"].asString() != source_hash) {
      return Fail("origin map describes a different generated source");
    }

    const auto &sources = value["sources"];
    if (!sources.isArray() || sources.empty() ||
        sources.size() > kMaxOriginSources) {
      return Fail("origin sources are empty or exceed the collection limit");
    }
    std::set<std::string> origin_inputs;
    std::optional<std::string> previous_input;
    for (const auto &source : sources) {
      if (!HasExactMembers(source, {"input", "sha256"}) ||
          !source["input"].isString() || !source["sha256"].isString()) {
        return Fail("origin source does not implement the v1 shape");
      }
      const std::string input = source["input"].asString();
      const std::string hash = source["sha256"].asString();
      if (!IsLogicalInput(input) || !IsLowerHex(hash, 64)) {
        return Fail("origin source identity or hash is invalid");
      }
      if ((previous_input && !Utf16Less(*previous_input, input)) ||
          !origin_inputs.insert(input).second) {
        return Fail("origin sources are duplicated or not strictly sorted");
      }
      previous_input = input;
    }

    const auto &segments = value["segments"];
    if (!segments.isArray() || segments.size() > kMaxOriginSegments) {
      return Fail("origin segments exceed the collection limit");
    }
    uint64_t previous_end = 0;
    std::optional<std::string> previous_origin;
    for (const auto &segment : segments) {
      if (!HasExactMembers(segment, {"generated", "origin", "precision"}) ||
          !segment["precision"].isString() ||
          segment["precision"].asString() != "module") {
        return Fail("origin segment does not implement module precision");
      }
      const auto &range = segment["generated"];
      const auto &origin = segment["origin"];
      if (!HasExactMembers(range, {"startByte", "endByte"}) ||
          !HasExactMembers(origin, {"input"}) || !origin["input"].isString()) {
        return Fail("origin segment range or identity has an invalid shape");
      }
      const auto start =
          ReadUnsignedInteger(range["startByte"], kMaxSafeInteger);
      const auto end = ReadUnsignedInteger(range["endByte"], kMaxSafeInteger);
      const std::string input = origin["input"].asString();
      if (!start || !end || *start < previous_end || *end <= *start ||
          *end > source_text.size()) {
        return Fail(
            "origin segment is empty, crossed, overlapping, or out of bounds");
      }
      if (!IsUtf8Boundary(source_text, *start) ||
          !IsUtf8Boundary(source_text, *end)) {
        return Fail("origin segment splits a UTF-8 code point");
      }
      if (!origin_inputs.contains(input)) {
        return Fail("origin segment references an unknown input");
      }
      if (previous_origin && previous_end == *start &&
          *previous_origin == input) {
        return Fail("adjacent equal-origin segments must be merged");
      }
      previous_end = *end;
      previous_origin = input;
    }
    return true;
  }

  bool DecodeEntryPoint(const Json::Value &value, CompilerRequest &request) {
    if (!HasExactMembers(value, {"stage", "wgsl", "metal"}) ||
        !value["stage"].isString() || !value["wgsl"].isString() ||
        !value["metal"].isString()) {
      return Fail("entry point does not implement the v1 shape");
    }
    request.stage = value["stage"].asString();
    request.entry_point = value["wgsl"].asString();
    request.emitted_name = value["metal"].asString();
    if (request.stage != "vertex" && request.stage != "fragment" &&
        request.stage != "compute") {
      return Fail("entry-point stage is unsupported");
    }
    if (!IsAsciiIdentifier(request.entry_point, 256)) {
      return Fail("WGSL entry-point name is not an identifier");
    }
    if (!IsEmittedIdentifier(request.emitted_name)) {
      return Fail("emitted name must use the reserved vgpu_ identifier domain");
    }
    return true;
  }

  bool DecodeOverrides(const Json::Value &value, CompilerRequest &request) {
    if (!value.isArray() || value.size() > kMaxOverrides) {
      return Fail("overrides exceed the collection limit");
    }
    std::optional<std::string> previous_name;
    for (const auto &item : value) {
      if (!HasExactMembers(item, {"name", "value"}) ||
          !item["name"].isString() || !item["value"].isObject()) {
        return Fail("override does not implement the v1 shape");
      }
      const std::string name = item["name"].asString();
      if (!IsAsciiIdentifier(name, 256) ||
          (previous_name && !Utf16Less(*previous_name, name))) {
        return Fail("override names are duplicated or not strictly sorted");
      }
      previous_name = name;
      const auto &encoded = item["value"];
      if (!encoded.isMember("type") || !encoded["type"].isString()) {
        return Fail("override value has no scalar type");
      }
      const std::string type = encoded["type"].asString();
      double numeric_value = 0;
      if (type == "bool") {
        if (!HasExactMembers(encoded, {"type", "value"}) ||
            !encoded["value"].isBool()) {
          return Fail("bool override payload is invalid");
        }
        numeric_value = encoded["value"].asBool() ? 1.0 : 0.0;
      } else if (type == "i32") {
        if (!HasExactMembers(encoded, {"type", "value"})) {
          return Fail("i32 override payload is invalid");
        }
        const auto parsed = ReadSignedInteger(
            encoded["value"], std::numeric_limits<int32_t>::min(),
            std::numeric_limits<int32_t>::max());
        if (!parsed) {
          return Fail("i32 override payload is invalid");
        }
        numeric_value = static_cast<double>(*parsed);
      } else if (type == "u32") {
        if (!HasExactMembers(encoded, {"type", "value"})) {
          return Fail("u32 override payload is invalid");
        }
        const auto parsed = ReadUnsignedInteger(
            encoded["value"], std::numeric_limits<uint32_t>::max());
        if (!parsed) {
          return Fail("u32 override payload is invalid");
        }
        numeric_value = static_cast<double>(*parsed);
      } else if (type == "f16" || type == "f32") {
        const size_t digits = type == "f16" ? 4 : 8;
        if (!HasExactMembers(encoded, {"type", "bits"}) ||
            !encoded["bits"].isString() ||
            !IsLowerHex(encoded["bits"].asString(), digits)) {
          return Fail("floating-point override bits are invalid");
        }
        const auto parsed = ParseHex(encoded["bits"].asString());
        if (!parsed) {
          return Fail("floating-point override bits are invalid");
        }
        if (type == "f32") {
          const float converted =
              std::bit_cast<float>(static_cast<uint32_t>(*parsed));
          if (!std::isfinite(converted)) {
            return Fail("floating-point override must be finite");
          }
          numeric_value = converted;
        } else {
          const uint16_t bits = static_cast<uint16_t>(*parsed);
          const uint16_t exponent = (bits >> 10U) & 0x1fU;
          const uint16_t fraction = bits & 0x03ffU;
          if (exponent == 0x1fU) {
            return Fail("floating-point override must be finite");
          }
          numeric_value = exponent == 0
                              ? std::ldexp(static_cast<double>(fraction), -24)
                              : std::ldexp(static_cast<double>(1024 + fraction),
                                           static_cast<int>(exponent) - 25);
          if ((bits & 0x8000U) != 0) {
            numeric_value = -numeric_value;
          }
        }
      } else {
        return Fail("override scalar type is unsupported");
      }
      if (!request.overrides
               .emplace(name,
                        OverrideValue{.type = type, .value = numeric_value})
               .second) {
        return Fail("override names are duplicated");
      }
    }
    return true;
  }

  template <typename Request>
  bool DecodeFeatures(const Json::Value &value, Request &request) {
    if (!value.isArray() || value.size() > kMaxLanguageFeatures) {
      return Fail("language features exceed the collection limit");
    }
    static const std::set<std::string> kAllowedFeatures{
        "dual_source_blending", "f16", "sized_binding_array",
        "uniform_buffer_standard_layout", "unrestricted_pointer_parameters"};
    std::optional<std::string> previous;
    for (const auto &item : value) {
      if (!item.isString()) {
        return Fail("language feature is not a string");
      }
      const std::string feature = item.asString();
      const bool pattern =
          !feature.empty() && feature.size() <= 256 && feature[0] >= 'a' &&
          feature[0] <= 'z' &&
          std::all_of(feature.begin() + 1, feature.end(),
                      [](unsigned char character) {
                        return (character >= 'a' && character <= 'z') ||
                               (character >= '0' && character <= '9') ||
                               character == '_';
                      });
      if (!pattern || (previous && !Utf16Less(*previous, feature))) {
        return Fail("language features are duplicated or not strictly sorted");
      }
      if (!kAllowedFeatures.contains(feature)) {
        return Fail("unsupported language feature");
      }
      previous = feature;
      request.features.insert(feature);
    }
    return true;
  }

  bool DecodeInterfaceType(const Json::Value &value, InterfaceType &type) {
    if (!HasExactMembers(value, {"scalar", "width"}) ||
        !value["scalar"].isString()) {
      return Fail("shader interface type does not implement the v1 shape");
    }
    const std::string scalar = value["scalar"].asString();
    if (scalar != "bool" && scalar != "f16" && scalar != "f32" &&
        scalar != "i32" && scalar != "u32") {
      return Fail("shader interface scalar type is unsupported");
    }
    const auto width = ReadUnsignedInteger(value["width"], 4);
    if (!width || *width == 0) {
      return Fail("shader interface vector width is unsupported");
    }
    type = InterfaceType{.scalar = scalar,
                         .width = static_cast<uint32_t>(*width)};
    return true;
  }

  bool DecodeInterfaceValue(const Json::Value &value, std::string_view stage,
                            std::string_view direction,
                            const std::set<std::string> &features,
                            InterfaceValue &decoded) {
    if (!HasAllowedMembers(value, {"type", "invariant"},
                           {"location", "builtin", "interpolation",
                            "blendSource"}) ||
        !value["invariant"].isBool() ||
        !DecodeInterfaceType(value["type"], decoded.type)) {
      return Fail("shader interface value does not implement the v1 shape");
    }
    decoded.invariant = value["invariant"].asBool();
    const bool has_location = value.isMember("location");
    const bool has_builtin = value.isMember("builtin");
    if (has_location == has_builtin) {
      return Fail("shader interface value must have exactly one semantic key");
    }
    if (has_location) {
      const auto location = ReadUnsignedInteger(
          value["location"], std::numeric_limits<uint32_t>::max());
      if (!location || decoded.type.scalar == "bool") {
        return Fail("shader interface location or type is unsupported");
      }
      if (stage == "compute") {
        return Fail("compute shader interface values must use builtins");
      }
      decoded.location = static_cast<uint32_t>(*location);
    } else {
      if (!value["builtin"].isString()) {
        return Fail("shader interface builtin is not a string");
      }
      decoded.builtin = value["builtin"].asString();
    }
    if (value.isMember("interpolation")) {
      const auto &interpolation = value["interpolation"];
      if (!HasExactMembers(interpolation, {"type", "sampling"}) ||
          !interpolation["type"].isString() ||
          !interpolation["sampling"].isString()) {
        return Fail("shader interface interpolation is invalid");
      }
      const std::string type = interpolation["type"].asString();
      const std::string sampling = interpolation["sampling"].asString();
      const bool valid =
          ((type == "perspective" || type == "linear") &&
           (sampling == "center" || sampling == "centroid" ||
            sampling == "sample")) ||
          (type == "flat" &&
           (sampling == "first" || sampling == "either"));
      if (!valid) {
        return Fail("shader interface interpolation pair is unsupported");
      }
      decoded.interpolation =
          InterfaceInterpolation{.type = type, .sampling = sampling};
    }
    if (value.isMember("blendSource")) {
      const auto blend_source = ReadUnsignedInteger(value["blendSource"], 1);
      if (!blend_source) {
        return Fail("shader interface blend source is invalid");
      }
      decoded.blend_source = static_cast<uint32_t>(*blend_source);
    }

    const bool linked_location =
        decoded.location &&
        ((stage == "vertex" && direction == "outputs") ||
         (stage == "fragment" && direction == "inputs"));
    if (linked_location != decoded.interpolation.has_value()) {
      return Fail("shader interface interpolation is not normalized by role");
    }
    if (linked_location &&
        (decoded.type.scalar == "i32" || decoded.type.scalar == "u32") &&
        decoded.interpolation->type != "flat") {
      return Fail("integral inter-stage location is not flat");
    }
    if (decoded.type.scalar == "f16" && !features.contains("f16")) {
      return Fail("f16 shader interface type lacks the f16 feature");
    }

    std::optional<InterfaceType> expected_builtin;
    if (decoded.builtin) {
      const auto expect = [&](std::string scalar, uint32_t width) {
        expected_builtin =
            InterfaceType{.scalar = std::move(scalar), .width = width};
      };
      if (stage == "vertex" && direction == "inputs" &&
          (*decoded.builtin == "vertex_index" ||
           *decoded.builtin == "instance_index")) {
        expect("u32", 1);
      } else if (stage == "vertex" && direction == "outputs" &&
                 *decoded.builtin == "position") {
        expect("f32", 4);
      } else if (stage == "fragment" && direction == "inputs" &&
                 *decoded.builtin == "position") {
        expect("f32", 4);
      } else if (stage == "fragment" && direction == "inputs" &&
                 *decoded.builtin == "front_facing") {
        expect("bool", 1);
      } else if (stage == "fragment" && direction == "inputs" &&
                 (*decoded.builtin == "sample_index" ||
                  *decoded.builtin == "sample_mask")) {
        expect("u32", 1);
      } else if (stage == "fragment" && direction == "outputs" &&
                 *decoded.builtin == "frag_depth") {
        expect("f32", 1);
      } else if (stage == "fragment" && direction == "outputs" &&
                 *decoded.builtin == "sample_mask") {
        expect("u32", 1);
      } else if (stage == "compute" && direction == "inputs" &&
                 (*decoded.builtin == "local_invocation_id" ||
                  *decoded.builtin == "global_invocation_id" ||
                  *decoded.builtin == "workgroup_id" ||
                  *decoded.builtin == "num_workgroups")) {
        expect("u32", 3);
      } else if (stage == "compute" && direction == "inputs" &&
                 *decoded.builtin == "local_invocation_index") {
        expect("u32", 1);
      }
      if (!expected_builtin || decoded.type != *expected_builtin) {
        return Fail("shader interface builtin or builtin type is unsupported");
      }
    }

    const bool may_be_invariant =
        stage == "vertex" && direction == "outputs" && decoded.builtin &&
        *decoded.builtin == "position";
    if (decoded.invariant && !may_be_invariant) {
      return Fail("shader interface invariant is unsupported in this role");
    }
    if (decoded.blend_source &&
        (stage != "fragment" || direction != "outputs" ||
         !decoded.location || *decoded.location != 0)) {
      return Fail("shader interface blend source is unsupported in this role");
    }
    if (stage == "vertex" && direction == "inputs" && decoded.location &&
        *decoded.location > 30) {
      return Fail("vertex interface exceeds Metal attribute(30)");
    }
    if (stage == "fragment" && direction == "outputs" && decoded.location &&
        *decoded.location > 7) {
      return Fail("fragment interface exceeds Metal color(7)");
    }
    return true;
  }

  bool DecodeInterfaceValues(const Json::Value &value,
                             std::string_view stage,
                             std::string_view direction,
                             const std::set<std::string> &features,
                             std::vector<InterfaceValue> &decoded) {
    const size_t maximum = stage == "compute" && direction == "inputs"
                               ? 5
                               : kMaxInterfaceValues;
    if (!value.isArray() || value.size() > maximum ||
        (stage == "compute" && direction == "outputs" && !value.empty())) {
      return Fail("shader interface values exceed the role limit");
    }
    const auto less = [](const InterfaceValue &left,
                         const InterfaceValue &right) {
      if (left.location.has_value() != right.location.has_value()) {
        return left.location.has_value();
      }
      if (left.location) {
        const uint32_t left_blend =
            left.blend_source ? *left.blend_source + 1 : 0;
        const uint32_t right_blend =
            right.blend_source ? *right.blend_source + 1 : 0;
        return std::tie(*left.location, left_blend) <
               std::tie(*right.location, right_blend);
      }
      return *left.builtin < *right.builtin;
    };
    for (const auto &item : value) {
      InterfaceValue interface_value;
      if (!DecodeInterfaceValue(item, stage, direction, features,
                                interface_value)) {
        return false;
      }
      if (!decoded.empty() && !less(decoded.back(), interface_value)) {
        return Fail(
            "shader interface values are duplicated or not strictly sorted");
      }
      decoded.push_back(std::move(interface_value));
    }
    return true;
  }

  bool DecodeSemanticInterface(const Json::Value &value,
                               CompilerRequest &request) {
    if (!HasExactMembers(value, {"kind", "inputs", "outputs"}) ||
        !value["kind"].isString()) {
      return Fail("semantic interface does not implement the v1 shape");
    }
    request.semantic_interface.kind = value["kind"].asString();
    if (request.semantic_interface.kind != request.stage) {
      return Fail("semantic interface kind differs from the entry-point stage");
    }
    if (!DecodeInterfaceValues(value["inputs"], request.stage, "inputs",
                               request.features,
                               request.semantic_interface.inputs) ||
        !DecodeInterfaceValues(value["outputs"], request.stage, "outputs",
                               request.features,
                               request.semantic_interface.outputs)) {
      return false;
    }
    if (request.stage == "vertex" &&
        std::count_if(request.semantic_interface.outputs.begin(),
                      request.semantic_interface.outputs.end(),
                      [](const auto &output) {
                        return output.builtin &&
                               *output.builtin == "position";
                      }) != 1) {
      return Fail("vertex shader interface must have one position output");
    }
    if (request.stage == "fragment") {
      std::vector<const InterfaceValue *> color_outputs;
      std::vector<const InterfaceValue *> dual_source;
      for (const auto &output : request.semantic_interface.outputs) {
        if (output.location) {
          color_outputs.push_back(&output);
        }
        if (output.blend_source) {
          dual_source.push_back(&output);
        }
      }
      if (!dual_source.empty() &&
          (!request.features.contains("dual_source_blending") ||
           color_outputs.size() != 2 || dual_source.size() != 2 ||
           *dual_source[0]->location != 0 ||
           *dual_source[1]->location != 0 ||
           *dual_source[0]->blend_source != 0 ||
           *dual_source[1]->blend_source != 1 ||
           dual_source[0]->type != dual_source[1]->type)) {
        return Fail("dual-source shader interface is not an exact pair");
      }
    }
    return true;
  }

  bool DecodeMetal(const Json::Value &value, CompilerRequest &request) {
    if (!HasExactMembers(value,
                         {"bindingModel", "bindings", "internalReservations",
                          "storageBufferSizes"}) ||
        !value["bindingModel"].isString() ||
        value["bindingModel"].asString() != kBindingModel) {
      return Fail("Metal profile has missing fields or an unsupported model");
    }
    if (!DecodeBindings(value["bindings"], request)) {
      return false;
    }
    const auto &reservations = value["internalReservations"];
    if (!reservations.isArray() || reservations.size() != 1) {
      return Fail("v1 requires exactly one internal reservation");
    }
    const auto &reservation = reservations[0];
    if (!HasExactMembers(reservation, {"role", "slots"}) ||
        !reservation["role"].isString() ||
        reservation["role"].asString() != "immediate-data" ||
        !reservation["slots"].isArray() || reservation["slots"].size() != 1) {
      return Fail("v1 internal reservation is invalid");
    }
    const auto &internal_slot = reservation["slots"][0];
    if (!HasExactMembers(internal_slot, {"mode", "resourceClass", "component",
                                         "index", "count"}) ||
        !internal_slot["mode"].isString() ||
        internal_slot["mode"].asString() != "direct" ||
        !internal_slot["resourceClass"].isString() ||
        internal_slot["resourceClass"].asString() != "buffer" ||
        !internal_slot["component"].isString() ||
        internal_slot["component"].asString() != "buffer") {
      return Fail("v1 immediate-data slot is invalid");
    }
    const auto internal_index = ReadUnsignedInteger(internal_slot["index"], 30);
    const auto internal_count = ReadUnsignedInteger(internal_slot["count"], 1);
    if (!internal_index || *internal_index != 30 || !internal_count ||
        *internal_count != 1) {
      return Fail("v1 immediate-data slot is invalid");
    }

    const auto &storage = value["storageBufferSizes"];
    if (!HasExactMembers(storage, {"model", "immediateDataByteOffset"}) ||
        !storage["model"].isString() ||
        storage["model"].asString() != kStorageSizeModel) {
      return Fail("storage-buffer-size model is invalid");
    }
    const auto offset =
        ReadUnsignedInteger(storage["immediateDataByteOffset"], 4);
    if (!offset || *offset != 4) {
      return Fail("storage-buffer-size offset is invalid");
    }
    return true;
  }

  bool DecodeBindings(const Json::Value &value, CompilerRequest &request) {
    if (!value.isArray() || value.size() > kMaxBindings) {
      return Fail("bindings exceed the collection limit");
    }
    struct Interval {
      std::string resource_class;
      uint64_t start;
      uint64_t end;
    };
    std::vector<Interval> intervals;
    std::optional<std::pair<uint32_t, uint32_t>> previous_coordinate;
    for (const auto &item : value) {
      if (!HasExactMembers(item, {"group", "binding", "slots"})) {
        return Fail("binding does not implement the v1 shape");
      }
      const auto group = ReadUnsignedInteger(
          item["group"], std::numeric_limits<uint32_t>::max());
      const auto binding = ReadUnsignedInteger(
          item["binding"], std::numeric_limits<uint32_t>::max());
      if (!group || !binding || !item["slots"].isArray() ||
          item["slots"].size() != 1) {
        return Fail("binding coordinate or direct slot is invalid");
      }
      const auto coordinate = std::pair<uint32_t, uint32_t>(
          static_cast<uint32_t>(*group), static_cast<uint32_t>(*binding));
      if (previous_coordinate && *previous_coordinate >= coordinate) {
        return Fail(
            "WGSL binding points are duplicated or not strictly sorted");
      }
      previous_coordinate = coordinate;
      const auto &slot = item["slots"][0];
      if (!HasExactMembers(
              slot, {"mode", "resourceClass", "component", "index", "count"}) ||
          !slot["mode"].isString() || slot["mode"].asString() != "direct" ||
          !slot["resourceClass"].isString() || !slot["component"].isString()) {
        return Fail("binding slot does not implement direct v1 shape");
      }
      const std::string resource_class = slot["resourceClass"].asString();
      const std::string component = slot["component"].asString();
      if ((resource_class != "buffer" && resource_class != "texture" &&
           resource_class != "sampler") ||
          component != resource_class) {
        return Fail("binding mapping has an unsupported or incoherent direct "
                    "component");
      }
      const auto index = ReadUnsignedInteger(
          slot["index"], std::numeric_limits<uint32_t>::max());
      const auto count = ReadUnsignedInteger(
          slot["count"], std::numeric_limits<uint32_t>::max());
      if (!index || !count || *count == 0 ||
          *index + *count >
              static_cast<uint64_t>(std::numeric_limits<uint32_t>::max()) + 1) {
        return Fail("binding mapping interval overflows uint32");
      }
      if (resource_class == "buffer" && *index + *count > 30) {
        return Fail(
            "external buffer binding interval reaches reserved buffer(30)");
      }
      intervals.push_back(Interval{resource_class, *index, *index + *count});
      request.mappings.push_back(Mapping{
          .kind = {},
          .source =
              tint::BindingPoint{.group = static_cast<uint32_t>(*group),
                                 .binding = static_cast<uint32_t>(*binding)},
          .resource_class = resource_class,
          .component = component,
          .index = static_cast<uint32_t>(*index),
          .count = static_cast<uint32_t>(*count),
      });
    }
    std::sort(intervals.begin(), intervals.end(),
              [](const auto &left, const auto &right) {
                return std::tie(left.resource_class, left.start, left.end) <
                       std::tie(right.resource_class, right.start, right.end);
              });
    for (size_t index = 1; index < intervals.size(); ++index) {
      if (intervals[index - 1].resource_class ==
              intervals[index].resource_class &&
          intervals[index].start < intervals[index - 1].end) {
        return Fail("binding mapping contains colliding Metal intervals");
      }
    }
    return true;
  }

  std::string error_;
};

} // namespace

DecodedRequest ReadRequest(std::istream &input) {
  std::string bytes;
  bytes.reserve(64 * 1024);
  std::array<char, 64 * 1024> chunk{};
  while (input) {
    input.read(chunk.data(), static_cast<std::streamsize>(chunk.size()));
    const auto count = input.gcount();
    if (count > 0) {
      if (bytes.size() > kMaxRequestBytes - static_cast<size_t>(count)) {
        return {.failure = RequestFailureKind::kFraming,
                .error = "request exceeds the stdin byte limit"};
      }
      bytes.append(chunk.data(), static_cast<size_t>(count));
    }
  }
  if (!input.eof()) {
    return {.failure = RequestFailureKind::kIo,
            .error = "could not finish reading stdin"};
  }
  if (bytes.empty() ||
      (bytes.size() >= 3 && static_cast<unsigned char>(bytes[0]) == 0xefU &&
       static_cast<unsigned char>(bytes[1]) == 0xbbU &&
       static_cast<unsigned char>(bytes[2]) == 0xbfU) ||
      !InspectUtf8(bytes).valid || !HasValidJsonLexemes(bytes)) {
    return {.failure = RequestFailureKind::kFraming,
            .error = "stdin failed strict UTF-8 JSON framing validation"};
  }

  Json::CharReaderBuilder builder;
  builder["collectComments"] = false;
  builder["allowComments"] = false;
  builder["allowTrailingCommas"] = false;
  builder["strictRoot"] = false;
  builder["allowDroppedNullPlaceholders"] = false;
  builder["allowNumericKeys"] = false;
  builder["allowSingleQuotes"] = false;
  // The lexical preflight owns the 64-container policy. JsonCpp counts one
  // extra root/value frame, so leave it exactly one frame of implementation
  // headroom rather than letting a policy-valid request throw.
  builder["stackLimit"] = static_cast<Json::UInt64>(kMaxJsonDepth + 1);
  builder["failIfExtra"] = true;
  builder["rejectDupKeys"] = true;
  builder["allowSpecialFloats"] = false;
  builder["skipBom"] = false;
  Json::Value root;
  std::string parse_errors;
  bool parsed = false;
  try {
    const std::unique_ptr<Json::CharReader> reader(builder.newCharReader());
    parsed = reader->parse(bytes.data(), bytes.data() + bytes.size(), &root,
                           &parse_errors);
  } catch (const Json::Exception &) {
    parsed = false;
  }
  if (!parsed) {
    return {.failure = RequestFailureKind::kFraming,
            .error = "stdin is not exactly one JSON value"};
  }
  if (!ValidateDecodedValues(root)) {
    return {.failure = RequestFailureKind::kFraming,
            .error = "JSON contains invalid Unicode or a non-finite number"};
  }
  Decoder decoder;
  const bool is_entry_inventory =
      root.isObject() && root["contractId"].isString() &&
      root["contractId"].asString() == kEntryInventoryContract;
  if (is_entry_inventory) {
    const auto identity = EntryInventoryRequestIdentity(bytes);
    auto request = decoder.DecodeEntryInventory(root, identity);
    if (!request) {
      return {.failure = RequestFailureKind::kProtocol,
              .error = decoder.error(),
              .operation = RequestOperation::kEntryInventory,
              .request_identity = identity};
    }
    return {
        .value = WorkerRequest(
            std::in_place_type<EntryInventoryRequest>, std::move(*request)),
        .operation = RequestOperation::kEntryInventory,
        .request_identity = identity,
    };
  }
  auto request = decoder.DecodeCompiler(root);
  if (!request) {
    return {.failure = RequestFailureKind::kProtocol, .error = decoder.error()};
  }
  return {.value = WorkerRequest(std::in_place_type<CompilerRequest>,
                                 std::move(*request))};
}

} // namespace vgpu::native
