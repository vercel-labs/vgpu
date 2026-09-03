#include "CapabilityPayloads.h"

static uint64_t hash_marker(const volatile char *marker, unsigned long count) {
  uint64_t value = 1469598103934665603ULL;
  for (unsigned long index = 0; index < count; index += 1) {
    value = (value ^ (unsigned char)marker[index]) * 1099511628211ULL;
  }
  return value;
}

uint64_t c0_core_payload(void) {
  static const volatile char marker[] = "C0_MARKER_CORE";
  return hash_marker(marker, sizeof(marker));
}

uint64_t c0_resource_payload(void) {
  static const volatile char marker[] = "C0_MARKER_RESOURCE";
  return hash_marker(marker, sizeof(marker));
}

uint64_t c0_render_payload(void) {
  static const volatile char marker[] = "C0_MARKER_RENDER";
  return hash_marker(marker, sizeof(marker));
}

uint64_t c0_compute_payload(void) {
  static const volatile char marker[] = "C0_MARKER_COMPUTE";
  return hash_marker(marker, sizeof(marker));
}
