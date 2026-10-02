# Asset delivery: texture formats, geometry and first frame

Use this reference when selecting export formats or investigating slow loading, large downloads or texture memory. Choose for the actual target importer and devices. A file extension is not a performance measurement.

## Separate the costs

Record **encoded response bytes**, decoded CPU allocations and **actual uploaded GPU formats/mips** separately. Measure navigation to first useful rendered frame and input readiness, not just the loading indicator. Inspect the dependency waterfall: deferred imports, manifests, model fetches, texture requests, decode/transcode, mip generation, buffer packing, pipeline creation and environment generation. A smaller texture does not fix requests started one at a time.

Use production builds, matched cameras/quality and several trials. Declare HTTP-cache policy, throttling, browser/GPU and whether OS, shader and CDN caches were controlled. Loading tests on an otherwise busy workstation have limited timing precision. Compare equal workloads; do not call a low-resolution placeholder the full-quality result.

## Texture delivery choices

KTX/KTX2 are **containers**. Distinguish their stored codec, supercompression and final GPU format. Zstd compresses transport/storage; it does not make RGBA8 into a GPU block format. Browser image decoders normally produce uncompressed pixels too.

| Delivery | Download and startup tradeoff | GPU residency | Suitable use and acceptance checks |
| --- | --- | --- | --- |
| PNG | Lossless at its stored bit depth; noisy maps may be large. Built-in image decode; ordinary browser loading has no supplied mip pyramid. | Depends on upload, commonly RGBA8; grayscale PNG alone does not guarantee R8. | Lossless interchange, simple delivery, masks or masters when stored precision suffices. Measure decode, color conversion and mip creation. Preserve float/16-bit masters when exporting 8-bit delivery. |
| Lossless WebP | Can beat 8-bit PNG substantially, but measure the actual maps. WebP is 8-bit; it cannot losslessly preserve 16-bit PNG. Browser decode and mip work remain. | Same as the equivalent PNG upload. | Lower download cost without intentional pixel loss. Verify decoded channels, alpha and color handling; preserve RGB under transparent pixels (e.g. `cwebp -exact`) when meaningful. Standard glTF needs importer support for `EXT_texture_webp` and correct fallback/required declarations. |
| Lossy WebP, JPEG or AVIF | Often small for photographic color; quality and decode cost depend on encoder, settings and device. Chroma subsampling can damage independent data channels. | Generally uncompressed after browser decode; file savings do not imply VRAM savings. | Test diffuse color/backgrounds against the required close-up. JPEG has no alpha. Do not default to lossy image codecs for normals, packed material data, contact AO or precision fields. glTF support differs by format/extension. |
| KTX1 (`.ktx`) | Native-format texture container with mip levels; useful for an existing fixed-platform pipeline. | Determined by contained raw or block format. | Preserve when an established importer needs it. For new portable supercompressed delivery evaluate KTX2; KTX1 and KTX2 are not interchangeable files. |
| KTX2 raw R/RG/RGBA + Zstd | Lossless relative to stored texels; offline mips remove runtime filtering. Inflation still costs CPU and staging memory; raw data can remain large. | Uncompressed R8, RG8, RGBA8, float, etc. | Exact scalar maps, normal fields, fallback delivery and formats requiring specific precision. Select channels explicitly; validate metadata, mips and decoded byte counts. |
| KTX2 ETC1S + BasisLZ | Usually prioritizes small transmission size; codebook/block approximation can affect detail and gradients. Needs a compatible transcoder. | The chosen BC/ETC/ASTC target, or uncompressed fallback; not the BasisLZ file size. | Candidate for color where errors are acceptable. Test fine masonry/text, dark gradients, alpha and target transcodes. Do not assume it preserves unrelated packed channels or sensitive normals. |
| KTX2 UASTC LDR 4×4 + optional Zstd/RDO | Usually trades more bytes for higher fidelity than ETC1S. RDO changes quality/size; Zstd alone is lossless over encoded blocks. Requires inflation/transcoding and decoder payload. | Final target, often BC7/ASTC 4×4; specialized channel targets only when the transcoder and swizzle contract support them. | Strong candidate for hero color, normal and material maps; still lossy. Validate decoded normal angular error, scalar error, mip seams and actual target-GPU renders. Compare total startup including WASM initialization. |
| Native BCn/ETC2/EAC/ASTC in KTX2 | Offline encoding; no universal-codec transcode when hardware supports the exact format. Optional supercompression still needs inflation. Multiple variants increase storage and cache complexity. | Fixed block size; e.g. BC4 4 bpp, BC5/BC7 8 bpp; ASTC rate varies by block footprint. | Known device fleets or negotiated variants. Query and request the actual WebGPU feature; provide a supported fallback. Never choose solely from OS/browser names. |

These are candidate-selection rules, not universal rankings or fixed compression ratios. New Basis modes, HDR codecs and extensions need explicit encoder, decoder, importer and device-version checks; support for UASTC LDR does not imply support for every newer mode.

For glTF, `KHR_texture_basisu` defines a specific KTX2 subset. An arbitrary raw-Zstd KTX2 is **not** automatically a compliant BasisU texture. External application maps can use a separate explicit contract. Test the final exported file in the target loader instead of merely renaming PNG to `.ktx2`.

### Channels, color and mipmaps

- Base color/emission usually use sRGB storage/sampling; AO, normals, roughness, metallic and scalar fields are linear. Declare lightmap radiometry and dynamic range: do not clamp HDR bakes into LDR merely to use an LDR codec.
- Preserve the decoder/swizzle contract for two-channel normals, including Y convention and Z reconstruction. Compare angular errors after the actual final transcode, not just intermediate KTX extraction to RGBA.
- Filter color in linear light, scalar fields as scalars and normals as vectors. Keep alpha edges and mip gutters valid; check highlight stability and roughness response during motion.
- Pack channels only when UVs, resolution, wrapping, filtering and lifetime are compatible. Independent data channels may need different compression quality.
- Include the entire mip chain in size comparisons. A base-only WebP versus a KTX2 with mips is not an equal payload comparison. Offline mips may trade extra bytes for less startup work.

### GPU memory examples

For a 2048×2048 texture with full square mips, R8 is about **5.33 MiB**, RG8 **10.67 MiB**, RGBA8 **21.33 MiB**, BC4 **2.67 MiB**, and BC5/BC7/ASTC 4×4 **5.33 MiB**. Small block-rounded tail mips add a few bytes. These are format-layout estimates, not total application/device allocations.

Use the exact sum per mip: `ceil(width / blockWidth) × ceil(height / blockHeight) × bytesPerBlock`. Raw formats use 1×1 blocks and their bytes per texel. Count arrays/faces and resident variants, staging buffers and replacement overlap separately. An RGBA fallback can erase the expected compression saving.

WebGPU compressed formats require supported, enabled `texture-compression-bc`, `texture-compression-etc2` or `texture-compression-astc` features as appropriate. Uploads must respect the format's block and mip-edge rules. `copyBufferToTexture` has 256-byte row-pitch alignment; `queue.writeTexture` does not impose that same requirement. Confirm the target vgpu version can create, bind and upload the chosen format; supported WebGPU hardware alone is insufficient.

## Make the model smaller without losing its structure

Inspect GLB chunks and classify geometry, embedded images, unused data and metadata before calling the entire file “the mesh”. Count exported vertices after UV/normal/material splits, not just Blender's edit-mode vertices or triangles.

After replacing exported attributes or externalizing images, check for abandoned accessors and buffer views before measuring the final download. Compression can preserve these unused intermediate arrays. Prune only after accounting for all references, including animation, skins and extensions; then decode the packaged file and verify the retained attributes and triangle-corner correspondence. Keep this packaging cleanup separate from topology reduction.

| Change | Potential saving | What to preserve or revalidate |
| --- | --- | --- |
| Externalize shared textures; stop fetching overridden fallback images | Download bytes, LOD-switch cache reuse | Keep portable references valid and sampling/UV bindings unchanged. A fallback is not removed if its bytes still ship inside the eagerly fetched GLB. Use content identity for sharing. External image dependencies make the GLB non-self-contained; retain a self-contained interchange copy when needed. |
| Remove unused attributes and inaccessible surfaces | Geometry/storage/upload | Verify every runtime pass and alternate view, including shadows/reflections. Removing per-face data can change sharing or bake correspondence. |
| Deduplicate vertices | Attribute bytes | Match **all used attributes**, including UV seams, hard normals and custom fields. Coincident positions alone are insufficient. Measure: already split meshes may have little exact duplication. |
| Meshopt entropy compression | Transport | Separate codec from quantization, reordering and simplification. The codec can be lossless; a full optimization preset need not be. Check decoder version and measured decode cost. |
| Quantize positions/normals/UVs or use attribute filters | Transport; GPU memory only if retained in GPU layout | Choose precision from object extent, closest view and bake texel density. Measure displacement, normal angular error and UV error in texels. UVs outside [0,1] need range-aware precision. Re-expanding to float on upload loses the vertex-memory benefit. |
| Cache/fetch reordering | Vertex processing and compression | Preserve triangle winding and every attribute association. Ordered UV hashes may change despite equivalent geometry: prove the remapping before updating bindings. |
| Simplify or author a lighter LOD | Geometry and shading | Preserve silhouette, openings, stairs, shore contacts, thin supports and map seams. Review actual near/rear/shadow views; address bake dependencies. A smaller LOD still costs startup if both versions are fetched eagerly. |
| Instance repeated modules | Repeated geometry/storage | Keep transforms, bounds, material variation and unique lighting UV requirements. Repeated geometry with different baked lightmaps may not share the whole mesh/material instance contract. |
| Draco | Alternative geometry transmission codec | Benchmark the complete chosen encoder/decoder against meshopt on these assets. Account for quantization, reconstructed attributes, ordering, WASM payload and peak memory. Neither codec is universally smallest or fastest. |

Do not apply `gltfpack`/optimizer defaults blindly to a baked scene: presets may quantize, merge, reorder, simplify or remove attributes. Export a candidate, inventory its required extensions and verify decoded geometry/UV correspondence and importer support. A small theoretical UV error does not by itself certify seam safety.

## Loading and acceptance

1. Preserve an input revision or lossless authoring export and record tool versions/options. Use separate candidates; never overwrite the only source to make a size chart.
2. Remove redundant transfers and fetch dependency stalls before introducing lossy codecs. Start independent downloads with a bounded concurrency and handle failed/cancelled requests; keep GPU error scopes and resource lifetime correct.
3. Reuse resources by content and sampling identity. Cache immutable content-addressed assets separately from mutable manifests. Avoid accidentally fetching both old and new variants.
4. For a progressive tier, measure placeholder, useful interactive scene and final-quality readiness independently. Bound simultaneous LOD/texture memory and make promotion safe during user input.
5. Compare matched hero, rear and detail renders, AO/normal/lightmap toggles, LOD switching and motion. Evaluate image error, normal angle or scalar error alongside visual inspection; no single metric certifies quality.
6. Accept only measured improvements to the task's cost/quality budget. Report file/response bytes, CPU decode/mip/upload timing, memory and first frame separately, with untested devices/fallbacks explicit.

## Primary references

Check current tool versions rather than copying a command for a different encoder release:

- [Khronos KTX2 specification](https://registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html): container, metadata, levels and supercompression.
- [KTX-Software tools](https://github.com/KhronosGroup/KTX-Software): `ktx create`, validation, transcode and extraction. Inspect installed `--help` for format and normal-map options.
- [Basis Universal](https://github.com/BinomialLLC/basis_universal): codecs, transcoder targets and current version limits.
- [glTF texture extensions](https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0): `KHR_texture_basisu`, `EXT_texture_webp`, `KHR_mesh_quantization`, `EXT_meshopt_compression` and `KHR_draco_mesh_compression` contracts.
- [WebGPU specification](https://www.w3.org/TR/webgpu/): feature negotiation, format capabilities, texture copies and uploads.
- [meshoptimizer](https://github.com/zeux/meshoptimizer): separate optimization, quantization, compression and simplification stages; inspect gltfpack options.
