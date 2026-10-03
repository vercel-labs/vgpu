# Supplied-shader renderer contract

Expose `node render.mjs /absolute/input.json /absolute/output-directory`. The output directory starts empty. Process every input frame in order in one process, dispose GPU resources, and write `result.json` plus one PNG per frame. Verification runs a fresh source copy, so source and asset paths must be portable.

Input is `{"version":1,"requestId":"example","frames":[{"cameraPosition":[0,0,8]}]}`. The initial camera orientation is identity. Projection is orthographic left/right `-4/4`, bottom/top `-3/3`, near/far `0.1/20`.

Use WebGPU's 0..1 clip-depth convention. For `left=l`, `right=r`, `bottom=b`, `top=t`, `near=n`, and `far=f`, the column-major orthographic matrix has diagonal `[2/(r-l), 2/(t-b), 1/(n-f), 1]` and translation `[(r+l)/(l-r), (t+b)/(b-t), n/(n-f)]`. The view matrix is `T(-cameraPosition)` and `viewProjection = projection * view`.

Render 512×384 offscreen `rgba8unorm` with opaque black clear, depth, no MSAA, blending, lighting, tone mapping, or rescaling. Draw axis-aligned side-0.6 boxes at `left=[-1.5,-0.6,0]` red, `right=[1.3,-0.4,0]` green, and `upper=[-0.1,1,0]` blue.

Load `integration.wgsl` at runtime and preserve its bytes. Bind its `style` with `gain=0.75,floor=0.125`, its `viewState`, and each object's world columns/tint through the declared interface.

Write:

```json
{"version":1,"requestId":"example","frames":[{"index":0,"color":"000-color.png","state":{"viewProjection":[0.25,0,0,0,0,0.3333333333,0,0,0,0,-0.0502512563,0,0,0,0.3969849246,1],"origins":{"left":[-1.5,-0.6,0],"right":[1.3,-0.4,0],"upper":[-0.1,1,0]}}}]}
```

The view-projection matrix is 16 finite column-major numbers. PNG rows use top-left origin. Filenames may differ but must be relative below the output directory. JSON numbers must be finite and frame indices/count/order, version, and request ID must match input.
