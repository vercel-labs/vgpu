# Material

A `Material` is the GPU state needed to draw a mesh with a shader. It contains:

- `pipeline`: the ready-to-bind `GPURenderPipeline`.
- `bindGroupLayout`: the layout for per-draw uniforms at group 0.
- `shader`: the compiled vgpu shader object.
- `uniformByteSize`: the number of bytes each uniform record must provide.

Use the `material()` factory to build custom materials from WGSL vertex and fragment entry points.

`MaterialUniformValue` is the value shape accepted by generic material uniform writers: a number, readonly number array, or typed numeric array.
