#ifndef C0_CAPABILITY_PAYLOADS_H
#define C0_CAPABILITY_PAYLOADS_H

#include <stdint.h>

uint64_t c0_core_payload(void);
uint64_t c0_resource_payload(void);
uint64_t c0_render_payload(void);
uint64_t c0_compute_payload(void);

#endif
