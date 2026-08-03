---
"@vgpu/cli": patch
---

Add the "Using vgpu without a bundler" and "Two-pass rendering" guides, link both from getting-started, and route the dogfood queries to them. Shaders in their own `.wgsl` file with no bundler now have one page (`resolveShader()` + `vgpu/node` + the ESM-only gotcha) instead of being findable only by symbol name, and the offscreen-depth-target-composited-to-the-canvas recipe — previously split across Draws, Passes and Frames — is one copy-pasteable page. `docs find "two-pass"` used to print "No docs found"; `"no bundler"`, `".wgsl file"`, `"offscreen depth"`, `"composite scene to canvas"` and `"render to texture"` now land on the guide that answers them.
