# Robot-arm renderer contract

Expose this command:

```sh
node render.mjs /absolute/input.json /absolute/output-directory
```

The output directory starts empty. Process every input frame in order in one process, dispose GPU resources, and write `result.json` plus one PNG per frame. Use portable source and asset paths: verification runs a fresh copy of the application with the installed dependencies linked into it.

Input is `{"version":1,"requestId":"example","frames":[frame]}`. A frame contains `basePosition: [x,y,z]`, `baseAngle`, `shoulderAngle`, `elbowAngle`, and `wristAngle`; angles are radians about +Z. Column vectors and column-major matrices use:

```text
base     = T(basePosition) Rz(baseAngle)
shoulder = base T(0,0.35,0) Rz(shoulderAngle)
elbow    = shoulder T(1.5,0,0) Rz(elbowAngle)
wrist    = elbow T(1.1,0,0) Rz(wristAngle)
tip      = wrist T(0.5,0,0)
```

Render at 512×384 to offscreen `rgba8unorm` with an opaque black clear, depth, no MSAA, blending, lighting, tone mapping, or rescaling. The camera is position `[0,0,8]`, identity orientation, with orthographic bounds left/right `-4/4`, bottom/top `-3/3`, near/far `0.1/20`.

| Part | Joint | Local center | Dimensions | RGB |
| --- | --- | --- | --- | --- |
| Base | base | `[0,0,0]` | `[0.6,0.5,0.3]` | `[255,255,0]` |
| Upper arm | shoulder | `[0.75,0,0]` | `[1.5,0.22,0.25]` | `[255,0,0]` |
| Forearm | elbow | `[0.55,0,0]` | `[1.1,0.18,0.2]` | `[0,255,0]` |
| Tool | wrist | `[0.25,0,0]` | `[0.5,0.24,0.2]` | `[0,0,255]` |
| Tip marker | tip | `[0,0,0.2]` | `[0.12,0.12,0.12]` | `[255,0,255]` |

Write this result shape. Every matrix is exactly 16 finite column-major numbers and excludes mesh center/size transforms.

```json
{"version":1,"requestId":"example","frames":[{"index":0,"color":"000-color.png","state":{"joints":{"base":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"shoulder":[1,0,0,0,0,1,0,0,0,0,1,0,0,0.35,0,1],"elbow":[1,0,0,0,0,1,0,0,0,0,1,0,1.5,0.35,0,1],"wrist":[1,0,0,0,0,1,0,0,0,0,1,0,2.6,0.35,0,1],"tip":[1,0,0,0,0,1,0,0,0,0,1,0,3.1,0.35,0,1]}}}]}
```

PNG rows have top-left origin. Filenames may differ but must be relative files below the output directory. JSON numbers must be finite and frame indices/count/order, version, and request ID must match the input.
