---
"@vgpu/wgsl": patch
---

Minification no longer corrupts leading-dot float literals. WGSL's `decimal_float_literal` may start with a dot (`.5`, `.0`, `.5e2`, `.5f`), but the scanner only opened a number token on a leading digit, so `.5` was tokenized as punctuation `.` plus the number `5`; the token printer's dot/digit separator rule then wrote `. 5`, which no device accepts (`unable to parse right side of assignment`). `.5` is now scanned as one number token, so `out_buf[0] = .5;` minifies to `out_buf[0]=.5;` instead of `out_buf[0]=. 5;`.

This was reachable from every entry point that minifies: `minify: true` threw the naga diagnostic (after #273, whitespace-only minification does too, instead of silently returning broken WGSL), and two shaders shipped in this repository — `apps/docs/examples/fluid/divergence.wgsl` and `project.wgsl`, both containing `…*.5*f32(grid.size.x)…` — could not be built with `minify: true` at all. Affected forms included `.5`, `.0`, `.5e2`, `.5f`, `-.5`, `(.5)`, `max(.5,1.0)`, `array<f32,2>(.5,1.0)`, `x*.25`, and the same literals inside imported modules.

Nothing else about tokenization changes. A `.` is only absorbed into a number when the very next character is a digit, and neither member names nor swizzles can start with a digit, so member access and swizzles (`v.x`, `a.xyz`, `s.inner.value`, `vec2f(1.0,2.0).x`) are untouched; trailing-dot and exponent forms (`1.`, `1.e3`, `1e3`, `0x1p1`, `0x1.8p1`) still go through the leading-digit path and minify byte-identically to before. A dot that is *not* adjacent to its digits in the source (`. 5`) is still printed with its separator rather than being fused into a literal the author did not write.
