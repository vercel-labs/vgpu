# Keyframed-rotation renderer contract

Expose this command:

```sh
node render.mjs /absolute/input.json /absolute/output-directory
```

The output directory starts empty. Process every input frame in order in one process, dispose GPU
resources, and write `result.json` plus one PNG per frame. Use portable source and asset paths:
verification runs a fresh copy of the application with the installed dependencies linked into it.

## Input and rotation behavior

Input has this shape:

```json
{"version":1,"requestId":"example","keyframes":[{"time":0,"rotation":[0,0,0,1]},{"time":1,"rotation":[0,0,0,1]}],"frames":[{"time":0}]}
```

- There are at least two keyframes, and keyframe times strictly increase.
- Each `rotation` is a unit quaternion in `[x,y,z,w]` order. A value and its negation denote the
  same orientation.
- Between consecutive keyframes the rigid body rotates about one fixed axis at constant angular
  speed in time, through the smaller of the two possible angles. Consecutive keyframes are never
  180 degrees apart and every segment is at most 170 degrees.
- At a keyframe time the orientation equals that keyframe. In this version every frame time is
  between the first and last keyframe times, inclusive.

## Scene and rendering

Render one rigid body at the origin with rotation only. Fix 3 exact-color markers to the body,
centered at these body-local positions:

| Local center | RGB |
| --- | --- |
| `[2,0,0]` | `[255,0,0]` |
| `[0,2,0]` | `[0,255,0]` |
| `[0,0,2]` | `[0,0,255]` |

Each marker may be either a cube with edge `0.4` or a sphere with diameter `0.4`. It is centered at
the listed position and oriented with the body.

Render at 512×384 to offscreen `rgba8unorm` with an opaque black clear. Use no MSAA, blending,
lighting, tone mapping, or rescaling. The camera is at `[0,0,10]` with identity orientation and an
orthographic projection: left/right `-4/4`, bottom/top `-3/3`, near/far `0.1/20`. Use column vectors
and a right-handed coordinate system.

## Output

Write this result shape:

```json
{"version":1,"requestId":"scene-quaternion-keyframes-example","frames":[{"index":0,"color":"000-color.png","state":{"world":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}}]}
```

`world` is the body's column-major 4×4 rotation transform with zero translation. It excludes marker
center and size transforms. Equivalent quaternion signs therefore produce identical output.

PNG rows start at the top-left. Filenames may differ but must be relative files below the output
directory. Every JSON number must be finite. Frame indices, count, order, version, and request ID
must match the input.
