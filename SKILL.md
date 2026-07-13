---
name: vgpu-ring1
description: >-
  Lane I skill: memorize the ring-1 nouns, R1–R4, canonical sketches, fix-its, and agent-confusion traps.
---


# vgpu ring-1 ownership SKILL

Este skill es el material congelado del rewrite: copialo tal cual cuando necesites recordar el contrato ring-1.


## Ring-1 nouns (aplicá este vocabulario)

```text
init(canvas?|opts) → Gpu           contexto; vgpu (browser) y vgpu/node (Dawn) mismo tipo. DPR explícito en init.
gpu.time / deltaTime / frameCount  números JS planos, NO bindings. Pasados explícito vía set().
gpu.shader(src) → Shader           WGSL resuelto + reflection. Cacheado.
gpu.pass(src, opts?) → Pass        fragment-only, quad interno provee uv. JAMÁS vertex buffers.
gpu.draw({shader, mesh?, ...})→Draw pipeline+mesh+bindings. Target-agnóstico, pipeline cache lazy/eager.
gpu.compute(src) → Compute         pipeline compute + dispatch. First-class.
gpu.uniforms(values)→SharedUniforms values-first (Variante A); layout diferido; 1 write → N consumidores.
gpu.target(opts) / gpu.pingPong    render target + ping-pong. target.size / target.texelSize.
gpu.frame(cb) / Frame.pass         encoder compartido multi-pass, on-demand. La única API de pass.
gpu.frame.loop(cb, {fps}?)         sugar opcional: rAF + gpu.time + auto-resize.
gpu.bundle({target}, record)→Bundle render bundles grabación explícita. Replay con p.bundles(b).
gpu.screen                         target del canvas (solo browser). En Node no existe → target().
```


## R1–R4 en una pantalla

```ts
// R1 — OWNERSHIP LATCHEADO: lo decide el TIPO DE VALOR del primer set().
pass.set({ speed: 2 });          // valor JS  → lib-owned (buffer propio, in-place)
pass.set({ camera: uniform });   // recurso   → user-owned (la lib solo bindea)
pass.set({ speed: buffer });     // ✖ flip de ownership = error con fix-it

// R2 — BIND GROUP CACHE: "recrear" = lookup por identidades de recursos.
pass.set({ src: pingPong.read }); // alterna entre 2 BGs cacheados → churn cero
                                  // (resize se amortiza con la misma mecánica)

// R3 — STALENESS ÚNICA: un bundle congela comandos + bind groups, NO contenidos.
draw.set({ fog: 0.2 });          // ✔ in-place, el bundle sigue válido
draw.set({ tex: otraTextura });  // ✖ rebind → bundle stale → error en dev
                                 //   nombrando binding y bundle; re-grabás VOS.

// R4 — GROUP CLAIM: claim estático, offsets dinámicos en el draw call.
draw.group(1, slot.bindGroup);            // grupo ENTERO; set() sobre él = error
p.draw(draw, { offsets: { 1: [off] } });  // offsets por draw (1000 objetos, 1 claim)
// draw.layout(1) → BGL reflejado del shader para construir pools compatibles.
```

## Sketch (a) — fullscreen pass (§2)

```ts
import { init } from "vgpu";

const gpu = await init(canvas, { dpr: [1, 2] });

const wave = gpu.pass(/* wgsl */ `
  // Declarás tus uniforms VOS, en WGSL. Es la única fuente de verdad:
  // la reflection AST calcula el layout (alignment incluido) y crea el
  // buffer + bind group por vos. Cero regex, cero doble declaración en JS.
  struct Params { time: f32, speed: f32 }
  @group(0) @binding(0) var<uniform> params: Params;

  // `uv` lo provee el quad fullscreen interno — la mayoría de los shaders
  // fullscreen no necesita resolución en absoluto.
  @fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return vec4f(uv, sin(params.time * params.speed) * .5 + .5, 1);
  }
`);

wave.set({ speed: 2 });
// ↑ `speed` es un VALOR JS PLANO → la lib es dueña del binding: crea el
//   buffer una vez, empaqueta según el layout reflejado y escribe in-place.
//   R1: el ownership queda LATCHEADO en este primer set(). Si más adelante
//   hacés wave.set({ speed: algúnBufferRing0 }) → error con fix-it.

gpu.frame.loop(() => {
  wave.set({ time: gpu.time });   // tiempo explícito, no magia
  wave.draw();                    // one-shot: crea un frame implícito
});

// ── Sugar de creación: EXACTAMENTE un set() inicial, nada más ────────
const wave2 = gpu.pass(WAVE_WGSL, { set: { speed: 2 } });
// Equivale 1:1 a: const wave2 = gpu.pass(WAVE_WGSL); wave2.set({ speed: 2 });
// Misma validación, mismo latching R1, una sola bolsa (NO hay buckets
// separados uniforms/bindings). La completitud se valida en draw(), no acá.
```

## Sketch (b) — set() dual + sharing (§3)

```ts
import { Uniform } from "vgpu/core";   // ring 0: el thin layer sigue público

// Recurso ring-0: VOS controlás usage, lifetime y sharing.
const camera = new Uniform(gpu.device, { size: 64, label: "camera" });

const cube  = gpu.draw({ shader: LIT_WGSL,  mesh: gpu.mesh(box()) });
const floor = gpu.draw({ shader: FLOOR_WGSL, mesh: gpu.mesh(plane()) });

cube.set({ camera });    // recurso → la lib SOLO bindea. No crea buffers,
floor.set({ camera });   // no escribe nada. 1 write → N consumidores:
camera.write(cam.viewProjection);   // un solo write alimenta ambos draws.
// (Este es el path ring-0 crudo — bytes, sin nombres. Para sharing con
//  set() por nombre y tipos inferidos, usá gpu.uniforms() → §4.)

// ── Mixed-ownership en el MISMO @group WGSL: permitido ───────────────
// En LIT_WGSL:
//   @group(0) @binding(0) var<uniform> camera: Camera;   ← user-owned
//   @group(0) @binding(1) var<uniform> params: Params;   ← lib-owned
cube.set({ params: { roughness: 0.4 } });   // conviven en el mismo bind group
// La lib arma el bind group mezclando ambos. Regla única de recreación:
// bindGroup(grupo) = f(identidades de recursos). Las entries lib-owned
// jamás cambian de identidad (R1) → solo un rebind user-owned lo recrea.
// COSTO a saber: si este draw está grabado en un bundle y rebindeás
// `camera`, el bundle se stalea "por culpa del vecino" — el error te
// nombra el binding culpable (§4, §8). Tip: agrupá en WGSL lo que rota junto.
```

## Sketch (c) — draw 3D + scene helpers (§6)

```ts
import { init } from "vgpu";
import { box, perspectiveCamera, orbit } from "vgpu/scene";

const gpu = await init(canvas, { dpr: [1, 2] });

// LIT_WGSL importa BRDF de la stdlib con el module system (sin cambios):
//   import { lambert } from "@vgpu/wgsl-std/light";
//   struct Camera { viewProjection: mat4x4f }  @group(0)@binding(0) ...
//   struct Light  { direction: vec3f, color: vec3f, intensity: f32 } ...
const cube = gpu.draw({
  shader: LIT_WGSL,
  mesh: gpu.mesh(box({ size: 1 })),   // vertex buffers → SIEMPRE draw, nunca pass
  depth: true,
  // targets: [gpu.screen]  ← opcional: compila el pipeline EAGER para esos
  // formatos y evitás el hitch del primer frame. Sin esto es lazy: el Draw
  // es target-agnóstico y cachea pipelines por (colorFormats, samples, depth).
});

const cam = perspectiveCamera({ fov: 45, position: [2, 2, 3], target: [0, 0, 0] });

gpu.frame.loop(() => {
  cube.set({
    camera: { viewProjection: cam.viewProjection },
    model: orbit(gpu.time),                                  // tiempo JS explícito
    light: { direction: [-1, -1, -1], color: [1, 1, 1], intensity: 1 },
  });
  cube.draw({ clear: [0.05, 0.05, 0.08, 1] });
});

// ── Frontera pass/draw (en piedra) ───────────────────────────────────
// gpu.pass():  fragment-only. Si tu WGSL declara su propio @vertex, la
//              reflection lo detecta y lo usa en vez del quad interno
//              (fullscreen tricks sin vertex buffers). Pero pass JAMÁS
//              acepta vertex buffers.
// gpu.draw():  en cuanto hay vertex data, la respuesta es draw. Mismo
//              modelo de reflection y set() — no hay salto de paradigma.
```

## Sketch (d) — multi-pass + targets (§7)

```ts
// HDR scene target + post a pantalla
const scene = gpu.target({ format: "rgba16float", depth: true, msaa: true });
const post  = gpu.pass(BLOOM_WGSL);

gpu.frame.loop((f) => {
  f.pass({ target: scene, clear: [0, 0, 0, 1] }, (p) => p.draw(cube));
  f.pass({ target: gpu.screen }, (p) => {
    post.set({
      src: scene.color,          // texture → user-owned, la lib solo bindea
      texel: scene.texelSize,    // resolución = PROPIEDAD DEL TARGET que leés,
    });                          // no un global. scene.size, gpu.screen.size:
    p.draw(post);                // siempre device px reales.
  });
});

// ── MRT / G-Buffer ───────────────────────────────────────────────────
const gbuf = gpu.target({
  colors: [{ format: "rgba8unorm" }, { format: "rgba16float" }],  // albedo, normal
  depth: true,
});
// Los outputs MRT (@location(0), @location(1)) van por el TARGET, no por
// set() — la reflection los ve como outputs del entry point, sin interacción.

const lighting = gpu.pass(LIGHTING_WGSL);
lighting.set({
  gAlbedo: gbuf.colors[0],
  gNormal: gbuf.colors[1],   // la reflection clasifica cada textura con
  gDepth:  gbuf.depth,       // precisión para el BGL: texture_depth_2d → depth,
                             // rgba16float sampleado → unfilterable-float, etc.
  samp: gpu.sampler(),       // samplers EXPLÍCITOS: uno compartido para N
                             // texturas (lo que el auto-sampler de ralph rompía).
                             // gpu.sampler(desc?) devuelve canónicos cacheados
                             // por descriptor → llamarlo N veces no crea N samplers.
});
```

## Sketch (e) — ping-pong + compute (§§8 & 11)

```ts
const sim = gpu.pass(SIM_WGSL);          // o gpu.compute, misma mecánica
const buf = gpu.pingPong(512, 512);

gpu.frame.loop((f) => {
  f.pass({ target: buf.write }, (p) => {
    sim.set({ src: buf.read });
    // ↑ la identidad de `src` cambia CADA frame (read↔write). R2: la lib
    //   hace lookup en el cache de bind groups por (layout, identidades).
    //   Frame 1: crea BG_a. Frame 2: crea BG_b. Frame 3+: alterna entre
    //   los dos cacheados → cero allocaciones, cero GC pressure.
    //   No es un special-case de PingPong: es la política general
    //   (el resize de §11 se amortiza igual). Evicción atada al destroy.
    p.draw(sim);
  });
  buf.swap();
});
```


```ts
const sim = gpu.compute(/* wgsl */ `
  struct Sim { dt: f32 }
  @group(0) @binding(0) var<uniform> sim: Sim;                       // lib-owned vía set()
  @group(0) @binding(1) var<storage, read>       src: array<vec4f>;  // user-owned
  @group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;  // user-owned
  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) id: vec3u) {
    dst[id.x] = src[id.x] + vec4f(0, -9.8 * sim.dt, 0, 0);
  }
`);

const buf = gpu.pingPongStorage(COUNT * 16);

gpu.frame.loop(() => {
  sim.set({ dt: gpu.deltaTime, src: buf.read, dst: buf.write });
  sim.dispatch(Math.ceil(COUNT / 64));
  buf.swap();
});

// ── Pre-check de aliasing (dev-mode, en dispatch) ────────────────────
sim.set({ src: miBuffer, dst: miBuffer });
sim.dispatch(1);
// ✖ VGPUError: `src` y `dst` apuntan al MISMO buffer y `dst` es
//   read_write (writable-storage aliasing, prohibido por WebGPU).
//   Fix: usá gpu.pingPongStorage() y alterná read/write.
//   (src+src read-only del mismo buffer es legal y pasa sin ruido.)
```

## Sketch (f) — tests determinísticos en Node (§13)

```ts
import { init } from "vgpu/node";        // Dawn; mismo código que browser
import { test, expect } from "vitest";

test("gradient shader renders", async () => {
  const gpu = await init({ size: [256, 256] });
  const target = gpu.target({ format: "rgba8unorm" });

  const p = gpu.pass(GRADIENT_WGSL);     // throws acá con diagnóstico de línea
                                         // si el WGSL no valida (naga/Dawn)
  p.set({ time: 1.25, speed: 1 });       // tiempo EXPLÍCITO → mismo pixel
                                         // en cada corrida, en cada máquina
  p.draw({ target });

  const px = await target.read();        // Uint8Array — listo para pixelmatch
  expect(px[0]).toBeGreaterThan(0);
  gpu.dispose();
});
// Para tests sin GPU real: import { init } from "vgpu/mock".
```

## Fix-it catalog (by-example §5)

```ts
// ── Binding jamás seteado (incluye samplers) ─────────────────────────
lighting.draw();
// ✖ VGPUError: el binding `samp` (@group(0) @binding(4), sampler) de
//   'lighting' nunca fue seteado. Opciones:
//     lighting.set({ samp: gpu.sampler() })            // valor canónico cacheado
//     lighting.group(0, miBindGroup)                   // o reclamá el grupo entero
//   Nunca se crean recursos fantasma por vos.

// ── Ownership flip (R1) ──────────────────────────────────────────────
wave.set({ speed: 2 });          // lib-owned desde acá
wave.set({ speed: miBuffer });
// ✖ VGPUError: `speed` es lib-owned desde su primer set() (valor JS).
//   No se puede cambiar el ownership de un binding. Si necesitás compartir
//   el buffer entre passes, creá un recurso ring-0 y pasalo desde el inicio:
//     const speed = new Uniform(gpu.device, { size: 4 });
//     wave.set({ speed });   // user-owned desde el primer set

// ── bool no host-shareable (hallazgo validado contra Dawn) ───────────
// struct Params { enabled: bool }  ← en un var<uniform>
// ✖ VGPUError: `bool` no es host-shareable en uniform/storage.
//   Fix: usá `u32` (0 | 1) → struct Params { enabled: u32 }

// ── Bundle stale nombrando al culpable (R3, dev-mode) ────────────────
p.bundles(staticScene);
// ✖ VGPUError: bundle 'staticScene' está stale: el binding `gNormal`
//   (@group(0) @binding(1)) del draw 'walls' cambió de recurso después
//   de la grabación. Los bundles congelan comandos y bind groups.
//   Fix: re-grabalo → staticScene = gpu.bundle({ target: scene }, ...)
//   (la re-grabación es siempre tuya; la lib solo detecta).
```

## Dónde puede confundirse un agente

- Sampler sin setear (viene de ralph auto-samplers) → error con fix-it de una línea (`set({ samp: gpu.sampler() })`).
- Esperar que un bundle "vea" `buf.swap()`/`target.resize()` → error de staleness con binding culpable + patrón de re-grabación (2 bundles).
- Intentar flipear ownership (valor→recurso) → error R1 con la alternativa correcta (crear recurso ring-0 desde el inicio).
- Pasar offsets en el claim en vez del draw → el error apunta a `p.draw(d, { offsets })`.
