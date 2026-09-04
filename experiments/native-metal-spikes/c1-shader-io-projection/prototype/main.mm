#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <array>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace {

std::string Utf8(NSString *value) {
  return value ? std::string(value.UTF8String) : std::string("<nil>");
}

id<MTLLibrary> CompileLibrary(id<MTLDevice> device,
                              const std::filesystem::path &path) {
  NSError *read_error = nil;
  NSString *source = [NSString stringWithContentsOfFile:@(path.c_str())
                                               encoding:NSUTF8StringEncoding
                                                  error:&read_error];
  if (!source) {
    std::cerr << "READ_FAIL path=" << path
              << " error=" << Utf8(read_error.localizedDescription) << "\n";
    return nil;
  }

  MTLCompileOptions *options = [MTLCompileOptions new];
  NSError *compile_error = nil;
  id<MTLLibrary> library = [device newLibraryWithSource:source
                                                options:options
                                                  error:&compile_error];
  if (!library) {
    std::cerr << "LIBRARY_FAIL path=" << path
              << " domain=" << Utf8(compile_error.domain)
              << " code=" << compile_error.code
              << " error=" << Utf8(compile_error.localizedDescription) << "\n";
    return nil;
  }
  std::cout << "LIBRARY_PASS path=" << path.filename().string() << "\n";
  return library;
}

id<MTLFunction> Function(id<MTLLibrary> library, NSString *name) {
  id<MTLFunction> function = [library newFunctionWithName:name];
  if (!function) {
    std::cerr << "FUNCTION_FAIL name=" << Utf8(name) << "\n";
    return nil;
  }
  std::cout << "FUNCTION name=" << Utf8(function.name)
            << " type=" << static_cast<unsigned long>(function.functionType)
            << " vertexAttributes=" << function.vertexAttributes.count
            << " stageInputAttributes=" << function.stageInputAttributes.count
            << "\n";
  for (MTLVertexAttribute *attribute in function.vertexAttributes) {
    std::cout << "  VERTEX_ATTRIBUTE name=" << Utf8(attribute.name)
              << " index=" << attribute.attributeIndex
              << " type=" << static_cast<unsigned long>(attribute.attributeType)
              << " active=" << attribute.active << "\n";
  }
  for (MTLAttribute *attribute in function.stageInputAttributes) {
    std::cout << "  STAGE_INPUT name=" << Utf8(attribute.name)
              << " index=" << attribute.attributeIndex
              << " type=" << static_cast<unsigned long>(attribute.attributeType)
              << " active=" << attribute.active << "\n";
  }
  return function;
}

MTLVertexDescriptor *CorrectVertexDescriptor() {
  MTLVertexDescriptor *descriptor = [MTLVertexDescriptor vertexDescriptor];
  descriptor.attributes[3].format = MTLVertexFormatFloat3;
  descriptor.attributes[3].offset = 0;
  descriptor.attributes[3].bufferIndex = 0;
  descriptor.attributes[7].format = MTLVertexFormatFloat;
  descriptor.attributes[7].offset = 12;
  descriptor.attributes[7].bufferIndex = 0;
  descriptor.layouts[0].stride = 16;
  descriptor.layouts[0].stepFunction = MTLVertexStepFunctionPerVertex;
  descriptor.layouts[0].stepRate = 1;
  return descriptor;
}

MTLVertexDescriptor *MissingAttributeSevenDescriptor() {
  MTLVertexDescriptor *descriptor = [MTLVertexDescriptor vertexDescriptor];
  descriptor.attributes[3].format = MTLVertexFormatFloat3;
  descriptor.attributes[3].offset = 0;
  descriptor.attributes[3].bufferIndex = 0;
  descriptor.layouts[0].stride = 16;
  descriptor.layouts[0].stepFunction = MTLVertexStepFunctionPerVertex;
  descriptor.layouts[0].stepRate = 1;
  return descriptor;
}

struct PipelineConfig {
  std::vector<NSUInteger> color_attachments;
  bool depth = false;
  bool dual_source_blending = false;
};

MTLRenderPipelineDescriptor *PipelineDescriptor(
    std::string_view label, id<MTLFunction> vertex, id<MTLFunction> fragment,
    MTLVertexDescriptor *vertex_descriptor, const PipelineConfig &config) {
  MTLRenderPipelineDescriptor *descriptor = [MTLRenderPipelineDescriptor new];
  descriptor.label = @(std::string(label).c_str());
  descriptor.vertexFunction = vertex;
  descriptor.fragmentFunction = fragment;
  descriptor.vertexDescriptor = vertex_descriptor;
  for (NSUInteger index : config.color_attachments) {
    descriptor.colorAttachments[index].pixelFormat = MTLPixelFormatRGBA8Unorm;
  }
  if (config.depth) {
    descriptor.depthAttachmentPixelFormat = MTLPixelFormatDepth32Float;
  }
  if (config.dual_source_blending) {
    auto *color = descriptor.colorAttachments[0];
    color.blendingEnabled = YES;
    color.sourceRGBBlendFactor = MTLBlendFactorSource1Color;
    color.destinationRGBBlendFactor = MTLBlendFactorZero;
    color.sourceAlphaBlendFactor = MTLBlendFactorSource1Alpha;
    color.destinationAlphaBlendFactor = MTLBlendFactorZero;
  }
  return descriptor;
}

bool Pipeline(id<MTLDevice> device, std::string_view label,
              id<MTLFunction> vertex, id<MTLFunction> fragment,
              MTLVertexDescriptor *vertex_descriptor,
              const PipelineConfig &config, bool expected_success) {
  MTLRenderPipelineDescriptor *descriptor =
      PipelineDescriptor(label, vertex, fragment, vertex_descriptor, config);

  NSError *error = nil;
  MTLRenderPipelineReflection *reflection = nil;
  const MTLPipelineOption options =
      MTLPipelineOptionBindingInfo | MTLPipelineOptionBufferTypeInfo;
  id<MTLRenderPipelineState> state =
      [device newRenderPipelineStateWithDescriptor:descriptor
                                           options:options
                                        reflection:&reflection
                                             error:&error];
  const bool success = state != nil;
  std::cout << "PIPELINE label=" << label << " success=" << success
            << " expected=" << expected_success;
  if (success) {
    std::cout << " vertexBindings=" << reflection.vertexBindings.count
              << " fragmentBindings=" << reflection.fragmentBindings.count;
    if (@available(macOS 26.0, *)) {
      std::cout << " stateReflection=" << (state.reflection != nil);
    }
  } else {
    std::cout << " domain=" << Utf8(error.domain) << " code=" << error.code
              << " error=" << Utf8(error.localizedDescription);
  }
  std::cout << "\n";

  if (reflection) {
    for (id<MTLBinding> binding in reflection.vertexBindings) {
      std::cout << "  VERTEX_BINDING name=" << Utf8(binding.name)
                << " index=" << binding.index
                << " type=" << static_cast<long>(binding.type)
                << " used=" << binding.used << "\n";
    }
    for (id<MTLBinding> binding in reflection.fragmentBindings) {
      std::cout << "  FRAGMENT_BINDING name=" << Utf8(binding.name)
                << " index=" << binding.index
                << " type=" << static_cast<long>(binding.type)
                << " used=" << binding.used << "\n";
    }
  }
  return success == expected_success;
}

bool Near(uint8_t actual, uint8_t expected) {
  return std::abs(static_cast<int>(actual) - static_cast<int>(expected)) <= 2;
}

bool Render(id<MTLDevice> device, id<MTLCommandQueue> queue,
            std::string_view label, id<MTLFunction> vertex,
            id<MTLFunction> fragment, const PipelineConfig &config,
            const std::vector<NSUInteger> &attachment_indices,
            const std::vector<std::array<uint8_t, 4>> &expected_pixels) {
  NSError *error = nil;
  id<MTLRenderPipelineState> state = [device
      newRenderPipelineStateWithDescriptor:PipelineDescriptor(label, vertex,
                                                              fragment, nil,
                                                              config)
                                     error:&error];
  if (!state) {
    std::cerr << "RENDER_PIPELINE_FAIL label=" << label
              << " error=" << Utf8(error.localizedDescription) << "\n";
    return false;
  }

  MTLTextureDescriptor *texture_descriptor = [MTLTextureDescriptor
      texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                   width:8
                                  height:8
                               mipmapped:NO];
  texture_descriptor.usage = MTLTextureUsageRenderTarget;
  texture_descriptor.storageMode = MTLStorageModeShared;

  NSMutableArray<id<MTLTexture>> *textures = [NSMutableArray array];
  MTLRenderPassDescriptor *pass =
      [MTLRenderPassDescriptor renderPassDescriptor];
  for (NSUInteger index : attachment_indices) {
    id<MTLTexture> texture =
        [device newTextureWithDescriptor:texture_descriptor];
    if (!texture) {
      std::cerr << "TEXTURE_FAIL label=" << label << " attachment=" << index
                << "\n";
      return false;
    }
    [textures addObject:texture];
    pass.colorAttachments[index].texture = texture;
    pass.colorAttachments[index].loadAction = MTLLoadActionClear;
    pass.colorAttachments[index].storeAction = MTLStoreActionStore;
    pass.colorAttachments[index].clearColor =
        MTLClearColorMake(0.0, 0.0, 1.0, 1.0);
  }

  id<MTLCommandBuffer> command_buffer = [queue commandBuffer];
  id<MTLRenderCommandEncoder> encoder =
      [command_buffer renderCommandEncoderWithDescriptor:pass];
  if (!encoder) {
    std::cerr << "ENCODER_FAIL label=" << label << "\n";
    return false;
  }
  [encoder setRenderPipelineState:state];
  [encoder drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:3];
  [encoder endEncoding];
  [command_buffer commit];
  [command_buffer waitUntilCompleted];
  if (command_buffer.status == MTLCommandBufferStatusError) {
    std::cerr << "COMMAND_FAIL label=" << label
              << " error=" << Utf8(command_buffer.error.localizedDescription)
              << "\n";
    return false;
  }

  bool ok = textures.count == expected_pixels.size();
  for (NSUInteger i = 0; i < textures.count && i < expected_pixels.size();
       ++i) {
    std::array<uint8_t, 4> pixel{};
    [textures[i] getBytes:pixel.data()
              bytesPerRow:pixel.size()
               fromRegion:MTLRegionMake2D(4, 4, 1, 1)
              mipmapLevel:0];
    const auto &expected = expected_pixels[i];
    const bool pixel_ok =
        Near(pixel[0], expected[0]) && Near(pixel[1], expected[1]) &&
        Near(pixel[2], expected[2]) && Near(pixel[3], expected[3]);
    ok &= pixel_ok;
    std::cout << "RENDER label=" << label
              << " attachment=" << attachment_indices[i]
              << " rgba=" << static_cast<unsigned>(pixel[0]) << ","
              << static_cast<unsigned>(pixel[1]) << ","
              << static_cast<unsigned>(pixel[2]) << ","
              << static_cast<unsigned>(pixel[3])
              << " expected=" << static_cast<unsigned>(expected[0]) << ","
              << static_cast<unsigned>(expected[1]) << ","
              << static_cast<unsigned>(expected[2]) << ","
              << static_cast<unsigned>(expected[3]) << " pass=" << pixel_ok
              << "\n";
  }
  return ok;
}

int Main(int argc, char **argv) {
  if (argc != 2) {
    std::cerr << "usage: metal-validation <generated-msl-directory>\n";
    return 64;
  }
  const std::filesystem::path root = argv[1];
  id<MTLDevice> device = MTLCreateSystemDefaultDevice();
  if (!device) {
    std::cerr << "DEVICE_FAIL no default Metal device\n";
    return 1;
  }
  std::cout << "DEVICE name=" << Utf8(device.name)
            << " registryID=" << device.registryID << "\n";

  id<MTLLibrary> vertex_library =
      CompileLibrary(device, root / "vertex_main.metal");
  id<MTLLibrary> fragment_library =
      CompileLibrary(device, root / "fragment_main.metal");
  id<MTLLibrary> fragment_single_library =
      CompileLibrary(device, root / "fragment_single.metal");
  id<MTLLibrary> scalar_fragment_library =
      CompileLibrary(device, root / "scalar_fragment.metal");
  id<MTLLibrary> sparse_vertex_library =
      CompileLibrary(device, root / "sparse_vertex.metal");
  id<MTLLibrary> position_only_library =
      CompileLibrary(device, root / "position_only_vertex.metal");
  id<MTLLibrary> color3_library =
      CompileLibrary(device, root / "constant_color3_fragment.metal");
  id<MTLLibrary> sparse_mrt_library =
      CompileLibrary(device, root / "sparse_mrt_fragment.metal");
  id<MTLLibrary> dual_constant_library =
      CompileLibrary(device, root / "dual_constant_fragment.metal");
  id<MTLLibrary> mismatch_library =
      CompileLibrary(device, root / "missing_interstage_fragment.metal");
  id<MTLLibrary> interpolation_mismatch_library =
      CompileLibrary(device, root / "interpolation_mismatch_fragment.metal");
  id<MTLLibrary> type_mismatch_library =
      CompileLibrary(device, root / "type_mismatch_fragment.metal");
  if (!vertex_library || !fragment_library || !fragment_single_library ||
      !scalar_fragment_library || !sparse_vertex_library ||
      !position_only_library || !color3_library || !sparse_mrt_library ||
      !dual_constant_library || !mismatch_library ||
      !interpolation_mismatch_library || !type_mismatch_library) {
    return 1;
  }

  id<MTLFunction> vertex = Function(vertex_library, @"emitted_vertex");
  id<MTLFunction> fragment = Function(fragment_library, @"emitted_fragment");
  id<MTLFunction> fragment_single =
      Function(fragment_single_library, @"emitted_fragment_single");
  id<MTLFunction> scalar_fragment =
      Function(scalar_fragment_library, @"emitted_scalar");
  id<MTLFunction> sparse_vertex =
      Function(sparse_vertex_library, @"emitted_sparse_vertex");
  id<MTLFunction> position_only =
      Function(position_only_library, @"emitted_position_only_vertex");
  id<MTLFunction> color3 =
      Function(color3_library, @"emitted_constant_color3_fragment");
  id<MTLFunction> sparse_mrt =
      Function(sparse_mrt_library, @"emitted_sparse_mrt_fragment");
  id<MTLFunction> dual_constant =
      Function(dual_constant_library, @"emitted_dual_constant_fragment");
  id<MTLFunction> mismatch =
      Function(mismatch_library, @"emitted_missing_interstage_fragment");
  id<MTLFunction> interpolation_mismatch =
      Function(interpolation_mismatch_library,
               @"emitted_interpolation_mismatch_fragment");
  id<MTLFunction> type_mismatch =
      Function(type_mismatch_library, @"emitted_type_mismatch_fragment");
  if (!vertex || !fragment || !fragment_single || !scalar_fragment ||
      !sparse_vertex || !position_only || !color3 || !sparse_mrt ||
      !dual_constant || !mismatch || !interpolation_mismatch ||
      !type_mismatch) {
    return 1;
  }

  id<MTLCommandQueue> queue = [device newCommandQueue];
  if (!queue) {
    std::cerr << "QUEUE_FAIL\n";
    return 1;
  }

  bool ok = true;
  ok &= Pipeline(device, "vertex-attrs-3-7_interstage-2-5-6", vertex,
                 fragment_single, CorrectVertexDescriptor(), {{0}}, true);
  ok &= Pipeline(device, "vertex-attr-7-missing", vertex, fragment_single,
                 MissingAttributeSevenDescriptor(), {{0}}, false);
  ok &= Pipeline(device, "interstage-location-4-missing", vertex, mismatch,
                 CorrectVertexDescriptor(), {{0}}, false);
  ok &=
      Pipeline(device, "interstage-interpolation-mismatch", vertex,
               interpolation_mismatch, CorrectVertexDescriptor(), {{0}}, true);
  ok &= Pipeline(device, "interstage-type-mismatch", vertex, type_mismatch,
                 CorrectVertexDescriptor(), {{0}}, false);
  ok &= Pipeline(device, "fragment-output-only-3", sparse_vertex,
                 scalar_fragment, nil, {{3}}, true);
  ok &= Pipeline(device, "fragment-output-3-descriptor-missing", sparse_vertex,
                 scalar_fragment, nil, {{0}}, true);
  ok &= Pipeline(device, "sparse-mrt-1-4", position_only, sparse_mrt, nil,
                 {{1, 4}}, true);
  ok &= Pipeline(device, "sparse-mrt-4-descriptor-missing", position_only,
                 sparse_mrt, nil, {{1}}, true);
  ok &= Pipeline(device, "dual-source-without-blend-factor", vertex, fragment,
                 CorrectVertexDescriptor(), {{0}, true, false}, true);
  ok &= Pipeline(device, "dual-source-with-source1-blend-factor", vertex,
                 fragment, CorrectVertexDescriptor(), {{0}, true, true}, true);

  ok &= Render(device, queue, "render-fragment-output-only-3", position_only,
               color3, {{3}}, {3}, {{{64, 128, 191, 255}}});
  ok &= Render(device, queue, "render-fragment-output-3-discarded",
               position_only, color3, {{0}}, {0}, {{{0, 0, 255, 255}}});
  ok &=
      Render(device, queue, "render-sparse-mrt-1-4", position_only, sparse_mrt,
             {{1, 4}}, {1, 4}, {{{255, 0, 0, 255}}, {{0, 255, 0, 255}}});
  ok &= Render(device, queue, "render-dual-source-disabled", position_only,
               dual_constant, {{0}}, {0}, {{{64, 128, 191, 204}}});
  ok &= Render(device, queue, "render-dual-source-enabled", position_only,
               dual_constant, {{0}, false, true}, {0}, {{{32, 32, 143, 102}}});

  std::cout << (ok ? "METAL_GATE_PASS" : "METAL_GATE_FAIL") << "\n";
  return ok ? 0 : 1;
}

} // namespace

int main(int argc, char **argv) {
  @autoreleasepool {
    return Main(argc, argv);
  }
}
