import type { Gpu } from "vgpu";
import type { Texture } from "vgpu/core";

import bakeWgsl from "./bake.wgsl";
import downsampleWgsl from "./downsample.wgsl";
import { LIGHT_ASSET_MANIFEST } from "./manifest";
import { loadPreloadedWallMask } from "./preload";
import type {
  LightAssetSpec,
  LightAssetTextures,
} from "./types";

const WORKGROUP_SIZE = 8;
const WALL_MASK_SIZE = [768, 512] as const;

interface BakedTexture {
  readonly texture: Texture;
}

export async function bakeLightAssetTextures(
  gpu: Gpu
): Promise<LightAssetTextures> {
  // The React integration starts this tiny fetch before device creation, so it
  // is normally resolved already. Await it here before touching GPU state to
  // keep cancellation and teardown ordered around one initialization task.
  const wallMask = await loadWallMaskTexture(gpu);
  const baked: BakedTexture[] = [];
  try {
    const bakeModule = gpu.gpu.createShaderModule({
      code: bakeWgsl.wgsl,
      label: "prism.light.bake",
    });
    const downsampleModule = gpu.gpu.createShaderModule({
      code: downsampleWgsl.wgsl,
      label: "prism.light.downsample",
    });
    const [
      wallMaterialPipeline,
      causticPipeline,
      downsamplePipeline,
      wallLightingPipeline,
    ] = await Promise.all([
      createPipeline(gpu.gpu, bakeModule, "wall_material"),
      createPipeline(gpu.gpu, bakeModule, "caustic_profile"),
      createPipeline(gpu.gpu, downsampleModule, "main"),
      createPipeline(
        gpu.gpu,
        bakeModule,
        wallMask ? "wall_lighting" : "wall_lighting_fallback"
      ),
    ]);
    baked.push(
      createBakedTexture(gpu, LIGHT_ASSET_MANIFEST["wall-material"]),
      createBakedTexture(gpu, LIGHT_ASSET_MANIFEST["wall-lighting"]),
      createBakedTexture(gpu, LIGHT_ASSET_MANIFEST["caustic-profile"])
    );
    const encoder = gpu.gpu.createCommandEncoder({
      label: "prism.light.bake",
    });
    encodeBase(
      gpu,
      encoder,
      wallMaterialPipeline,
      baked[0]!.texture
    );
    encodeBase(
      gpu,
      encoder,
      wallLightingPipeline,
      baked[1]!.texture,
      wallMask
    );
    encodeBase(gpu, encoder, causticPipeline, baked[2]!.texture);
    for (const { texture } of baked)
      encodeMipChain(gpu, encoder, downsamplePipeline, texture);
    gpu.gpu.queue.submit([encoder.finish()]);
    await gpu.gpu.queue.onSubmittedWorkDone();
    return {
      wallMaterial: baked[0]!.texture,
      wallLighting: baked[1]!.texture,
      causticProfile: baked[2]!.texture,
    };
  } catch (error) {
    for (const { texture } of baked) texture.destroy();
    throw error;
  } finally {
    wallMask?.destroy();
  }
}

function createBakedTexture(gpu: Gpu, spec: LightAssetSpec): BakedTexture {
  return {
    texture: gpu.device.createTexture({
      size: spec.size,
      format: "rgba8unorm",
      mipLevelCount: mipLevelCount(spec.size),
      usage: ["texture_binding", "storage_binding"],
      label: `prism.light.${spec.id}`,
    }),
  };
}

function mipLevelCount(size: readonly [number, number]): number {
  return Math.floor(Math.log2(Math.max(...size))) + 1;
}

function encodeBase(
  gpu: Gpu,
  encoder: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  output: Texture,
  mask?: Texture
): void {
  const entries: GPUBindGroupEntry[] = [
    {
      binding: 0,
      resource: output.gpu.createView({
        baseMipLevel: 0,
        mipLevelCount: 1,
      }),
    },
  ];
  if (mask) {
    entries.push(
      { binding: 1, resource: mask.view },
      {
        binding: 2,
        resource: gpu.gpu.createSampler({
          minFilter: "linear",
          magFilter: "linear",
        }),
      }
    );
  }
  const pass = encoder.beginComputePass({
    label: `${output.label}.base`,
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    gpu.gpu.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries,
    })
  );
  pass.dispatchWorkgroups(
    Math.ceil(output.size[0] / WORKGROUP_SIZE),
    Math.ceil(output.size[1] / WORKGROUP_SIZE)
  );
  pass.end();
}

function encodeMipChain(
  gpu: Gpu,
  encoder: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  texture: Texture
): void {
  for (let level = 1; level < texture.mipLevelCount; level++) {
    const width = Math.max(1, texture.size[0] >> level);
    const height = Math.max(1, texture.size[1] >> level);
    const pass = encoder.beginComputePass({
      label: `${texture.label}.mip${level}`,
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      gpu.gpu.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          {
            binding: 0,
            resource: texture.gpu.createView({
              baseMipLevel: level - 1,
              mipLevelCount: 1,
            }),
          },
          {
            binding: 1,
            resource: texture.gpu.createView({
              baseMipLevel: level,
              mipLevelCount: 1,
            }),
          },
        ],
      })
    );
    pass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_SIZE),
      Math.ceil(height / WORKGROUP_SIZE)
    );
    pass.end();
  }
}

async function createPipeline(
  device: GPUDevice,
  module: GPUShaderModule,
  entryPoint: string
): Promise<GPUComputePipeline> {
  const descriptor: GPUComputePipelineDescriptor = {
    layout: "auto",
    compute: { module, entryPoint },
    label: `prism.light.${entryPoint}`,
  };
  return device.createComputePipelineAsync
    ? device.createComputePipelineAsync(descriptor)
    : device.createComputePipeline(descriptor);
}

async function loadWallMaskTexture(gpu: Gpu): Promise<Texture | undefined> {
  let bitmap: ImageBitmap | undefined;
  let texture: Texture | undefined;
  try {
    const blob = await loadPreloadedWallMask();
    if (typeof createImageBitmap === "undefined") return undefined;
    try {
      bitmap = await createImageBitmap(blob, {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
    } catch {
      bitmap = await createImageBitmap(blob);
    }
    if (
      bitmap.width !== WALL_MASK_SIZE[0] ||
      bitmap.height !== WALL_MASK_SIZE[1]
    )
      throw new Error(
        `Wall mask is ${bitmap.width}x${bitmap.height}; expected ${WALL_MASK_SIZE.join("x")}.`
      );
    texture = gpu.device.createTexture({
      size: WALL_MASK_SIZE,
      format: "rgba8unorm",
      usage: ["texture_binding", "copy_dst", "render_attachment"],
      label: "prism.light.wall-mask",
    });
    gpu.gpu.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: texture.gpu },
      [...WALL_MASK_SIZE, 1]
    );
    return texture;
  } catch {
    texture?.destroy();
    return undefined;
  } finally {
    bitmap?.close();
  }
}
