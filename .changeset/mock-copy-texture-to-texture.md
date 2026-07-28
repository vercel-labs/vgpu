---
"@vgpu/core": patch
---

Implement `copyTextureToTexture` on the mock command encoder so code that builds mip chains or copies between textures boots on the mock adapter.
