# Inspect snapshot regeneration

If cube geometry, `wireframeMaterial`, `normalDebugMaterial`, or
`meshToWireframe` change in a way that affects rendered output, the
six snapshot PNGs in this directory must be regenerated.

The wireframe snapshots use a test-local readable cube mesh because
`meshToWireframe` requires `GPUBufferUsage.COPY_SRC`. The normal-debug
snapshots render `Mesh.box` directly because they do not require readback.

## Regeneration steps

1. Run `VGPU_WRITE_SNAPSHOTS=1 pnpm test:docker -- packages/render/tests/inspect`
   to write 6 PNGs from the current code.
2. Visually inspect each PNG. Expected appearance:
   - `box-wireframe-front.png`: looking mostly down the -Z axis with slight elevation; front face dominates with a sliver of the top face visible.
   - `box-wireframe-iso.png`: roughly 9 visible white edges from the 3 visible cube faces.
   - `box-wireframe-side.png`: looking mostly down the -X axis with slight elevation and slight Z offset; right face dominates with top/front slivers.
   - `box-normals-front.png`: solid blue, near `(187, 187, 255, 255)` after sRGB encoding.
   - `box-normals-iso.png`: 3 visible faces — green-, red-, and blue-tinted.
   - `box-normals-side.png`: solid red, near `(255, 187, 187, 255)` after sRGB encoding.
3. Commit the new PNGs.
4. Re-run the test suite without `VGPU_WRITE_SNAPSHOTS` to confirm byte-equal pass.

## Determinism

Snapshots assume Docker/Dawn rendering. Local non-Dawn runs may differ.
The test suite gates these tests on `VGPU_DOCKER_TEST=1`.
