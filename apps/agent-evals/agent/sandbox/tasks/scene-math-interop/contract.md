# ECS renderer contract

`ecs/` is an existing entity system that owns every transform (see `ecs/README.md`). Do not modify
anything under `ecs/`. Expose:

```sh
node render.mjs /absolute/input.json /absolute/output-directory
```

The output directory starts empty. Process every input frame in order in one process, dispose GPU
resources, and write `result.json` plus one PNG per frame. Use portable paths: verification runs a
fresh copy of the application with the installed dependencies linked into it.

## Input

`{"version":1,"requestId":string,"entities":[entity],"frames":[frame]}`

- An entity is `{"parent":key|null,"position":[x,y,z],"rotation":[x,y,z,w],"scale":[x,y,z]}` plus an
  optional `"renderable":{"size":[w,h,d],"offset":[x,y,z],"color":[r,g,b]}` or
  `"camera":{"left","right","bottom","top","near","far"}`. Rotations are unit quaternions, XYZW.
- **An entity's key is its array position in `entities`.** Keys identify entities in commands and
  output; they are not ECS handles or rows. A parent key always refers to an earlier entity.
- Exactly one entity has `camera`. Its world transform is always rigid (no scale).
- A frame is `{"commands":[command]}`. Commands apply in order, before that frame renders, and their
  effects persist to later frames. **Frames carry no index; a frame's index is its array position.**
- In this version every command is `{"op":"set","key":k}` with any of `position`, `rotation`,
  `scale`. Each present field replaces that local component; other fields are unchanged.

## Transforms

Column vectors, column-major matrices. `local = T(position) R(rotation) S(scale)`, and
`world = parentWorld · local`: the ECS's world matrix. A renderable draws a unit box centred at the
origin transformed by `world · T(offset) · S(size)`. Size and offset never affect children.

The camera looks down −Z. `view = inverse(cameraWorld)` and
`viewProjection = orthographic(bounds) · view`, using WebGPU's 0..1 clip depth.

## Rendering

512×384, offscreen `rgba8unorm`, opaque black clear, with a depth test. No MSAA, blending, lighting,
tone mapping or rescaling. Each box is a flat, exact `color`.

Use the application's installed `math@0.1.0` for camera projection/inversion and mesh-matrix
composition. Render through `instances` from `vgpu/scene` and `instanceGeometry` from
`vgpu/scene/gpu`, explicitly publishing updates before drawing. Keep the ECS authoritative for
entity world matrices.

## Output

For every frame, `state.entities` lists every live entity (renderable or not), sorted by key, with
its 16-number world matrix (excluding offset/size). `state.viewProjection` is the matrix used for
that frame. All numbers are finite. PNG rows start at the top-left. Filenames may differ but must be
relative files below the output directory. The version, requestId, frame count and order must
match the input.

Example input:

```json
{"version":1,"requestId":"example","entities":[{"parent":null,"position":[0,0,10],"rotation":[0,0,0,1],"scale":[1,1,1],"camera":{"left":-4,"right":4,"bottom":-3,"top":3,"near":0.1,"far":20}},{"parent":null,"position":[1,0,0],"rotation":[0,0,0.7071067811865476,0.7071067811865476],"scale":[2,1,1],"renderable":{"size":[1,0.5,0.5],"offset":[0,0,0],"color":[255,0,0]}}],"frames":[{"commands":[]},{"commands":[{"op":"set","key":1,"position":[0,1,0]}]}]}
```

Its output:

```json
{"version":1,"requestId":"example","frames":[{"index":0,"color":"000-color.png","state":{"viewProjection":[0.25,0,0,0,0,0.3333333333333333,0,0,0,0,-0.05025125628140704,0,0,0,0.4974874371859297,1],"entities":[{"key":0,"world":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,10,1]},{"key":1,"world":[0,2,0,0,-1,0,0,0,0,0,1,0,1,0,0,1]}]}},{"index":1,"color":"001-color.png","state":{"viewProjection":[0.25,0,0,0,0,0.3333333333333333,0,0,0,0,-0.05025125628140704,0,0,0,0.4974874371859297,1],"entities":[{"key":0,"world":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,10,1]},{"key":1,"world":[0,2,0,0,-1,0,0,0,0,0,1,0,0,1,0,1]}]}}]}
```
