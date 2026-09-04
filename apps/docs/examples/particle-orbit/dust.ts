// TypeGPU authors the dust simulation on the device vgpu owns. Its schemas
// define the buffer layout, generate the WGSL declarations, and type-check the
// bind group; vgpu consumes the resulting GPUBuffer for rendering.
import tgpu from 'typegpu';
import * as d from 'typegpu/data';

import { DUST_COUNT } from './pipeline';

const WORKGROUP_SIZE = 64;

export const Particle = d
  .struct({
    position: d.vec2f,
    velocity: d.vec2f,
    seed: d.f32,
    energy: d.f32,
    // Light color the mote flew through; stars.wgsl reads it back.
    tint: d.vec3f,
  })
  .$name('Particle');

export const SimParams = d
  .struct({
    time: d.f32,
    dt: d.f32,
    aspect: d.f32,
  })
  .$name('SimParams');

const simLayout = tgpu.bindGroupLayout({
  particles: { storage: (n: number) => d.arrayOf(Particle, n), access: 'mutable' },
  params: { uniform: SimParams },
  light: { texture: d.texture2d(d.f32) },
  lightSampler: { sampler: 'filtering' },
});

// Deterministic: no Math.random.
function hash01(seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export function initialParticles() {
  return Array.from({ length: DUST_COUNT }, (_, index) => {
    const ring = 70 + hash01(index * 4) * 190;
    const angle = hash01(index * 4 + 1) * Math.PI * 2;
    return {
      position: d.vec2f(Math.cos(angle) * ring, Math.sin(angle) * ring),
      velocity: d.vec2f(0, 0),
      seed: hash01(index * 4 + 2),
      energy: 0,
      tint: d.vec3f(0, 0, 0),
    };
  });
}

// The struct declarations come from the schemas above.
export function simulationWgsl(): string {
  return tgpu.resolve({
    template: /* wgsl */ `
      @group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
      @group(0) @binding(1) var<uniform> params: SimParams;
      @group(0) @binding(2) var light: texture_2d<f32>;
      @group(0) @binding(3) var lightSampler: sampler;

      const FOCAL_PX = 360.0;
      const HALF_HEIGHT_PX = 240.0;

      fn orbit(index: f32, time: f32) -> vec3f {
        let radius = 0.62 + index * 0.34;
        let speed = 0.56 - index * 0.07;
        let angle = time * speed + index * 1.5707963;
        let tilt = -0.42 + index * 0.28;
        let local = vec2f(cos(angle) * radius, sin(angle) * radius * 0.62);
        let c = cos(tilt);
        let s = sin(tilt);
        let xy = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
        return vec3f(xy, 3.2 + sin(angle) * 0.28);
      }

      fn headPx(index: f32, time: f32) -> vec2f {
        let p = orbit(index, time);
        return p.xy * (FOCAL_PX / max(p.z, 0.01));
      }

      fn lightUv(px: vec2f, aspect: f32) -> vec2f {
        return vec2f(
          0.5 + px.x / (2.0 * HALF_HEIGHT_PX * aspect),
          0.5 - px.y / (2.0 * HALF_HEIGHT_PX),
        );
      }

      fn irradianceAt(px: vec2f, aspect: f32) -> vec3f {
        return textureSampleLevel(light, lightSampler, lightUv(px, aspect), 0.0).rgb;
      }

      fn luminance(color: vec3f) -> f32 {
        return dot(color, vec3f(0.2126, 0.7152, 0.0722));
      }

      // Ring spring + swirl + head shove + climb toward the light field.
      @compute @workgroup_size(${WORKGROUP_SIZE})
      fn main(@builtin(global_invocation_id) gid: vec3u) {
        if (gid.x >= arrayLength(&particles)) {
          return;
        }
        var p = particles[gid.x];

        let distance = max(length(p.position), 1.0);
        let outward = p.position / distance;
        let tangent = vec2f(-outward.y, outward.x);

        let ring = 70.0 + p.seed * 190.0;
        var accel = (outward * ring - p.position) * 0.9;
        accel += tangent * (26.0 + p.seed * 42.0) * (140.0 / (distance + 60.0));

        var nearest = 1e9;
        for (var i = 0u; i < 4u; i++) {
          let away = p.position - headPx(f32(i), params.time);
          let d2 = dot(away, away);
          nearest = min(nearest, d2);
          accel += away * (2600.0 / (d2 + 300.0));
        }

        let eps = 14.0;
        let glow = irradianceAt(p.position, params.aspect);
        let gradient = vec2f(
          luminance(irradianceAt(p.position + vec2f(eps, 0.0), params.aspect)) -
            luminance(irradianceAt(p.position - vec2f(eps, 0.0), params.aspect)),
          luminance(irradianceAt(p.position + vec2f(0.0, eps), params.aspect)) -
            luminance(irradianceAt(p.position - vec2f(0.0, eps), params.aspect)),
        );
        accel += gradient * 900.0;
        p.tint = mix(p.tint, glow, 1.0 - exp(-params.dt * 3.0));

        p.velocity = (p.velocity + accel * params.dt) * exp(-params.dt * 1.6);
        p.position += p.velocity * params.dt;

        let excited = clamp(2400.0 / (nearest + 240.0), 0.0, 1.0);
        p.energy = max(excited, p.energy * exp(-params.dt * 2.2));

        particles[gid.x] = p;
      }
    `,
    externals: { Particle, SimParams },
  });
}

export function createDust(device: GPUDevice) {
  const root = tgpu.initFromDevice({ device });
  const particles = root
    .createBuffer(d.arrayOf(Particle, DUST_COUNT), initialParticles())
    .$usage('storage');
  const params = root
    .createBuffer(SimParams, { time: 0, dt: 0, aspect: 1 })
    .$usage('uniform');
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [root.unwrap(simLayout)] }),
    compute: {
      module: device.createShaderModule({ code: simulationWgsl() }),
      entryPoint: 'main',
    },
  });
  const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  let bindGroup: GPUBindGroup | undefined;

  return {
    buffer: root.unwrap(particles),
    // Rebound whenever a resize rebuilds the light field. createBindGroup is
    // typed against simLayout, so a schema drift fails right here.
    setLightField(view: GPUTextureView): void {
      bindGroup = root.unwrap(
        root.createBindGroup(simLayout, {
          particles,
          params,
          light: view,
          lightSampler: sampler,
        }),
      );
    },
    update(time: number, dt: number, aspect: number): void {
      if (!bindGroup) return;
      params.write({ time, dt: Math.min(dt, 1 / 30), aspect });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(DUST_COUNT / WORKGROUP_SIZE));
      pass.end();
      device.queue.submit([encoder.finish()]);
    },
    destroy(): void {
      particles.destroy();
      params.destroy();
    },
  };
}

export type Dust = ReturnType<typeof createDust>;
