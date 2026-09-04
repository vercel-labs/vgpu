cmake_minimum_required(VERSION 3.23)

project(vgpu_c1_tint_direct_build LANGUAGES C CXX)

foreach(required_root IN ITEMS VGPU_DAWN_ROOT VGPU_JSONCPP_ROOT VGPU_WORKER_ROOT)
  if(NOT DEFINED ${required_root} OR "${${required_root}}" STREQUAL "")
    message(FATAL_ERROR "${required_root} must name a pre-materialized source root")
  endif()
  get_filename_component(${required_root} "${${required_root}}" REALPATH)
  if(NOT IS_DIRECTORY "${${required_root}}")
    message(FATAL_ERROR "${required_root} is not a directory: ${${required_root}}")
  endif()
endforeach()

if(NOT CMAKE_BUILD_TYPE STREQUAL "Release")
  message(FATAL_ERROR "This spike only admits CMAKE_BUILD_TYPE=Release")
endif()
if(NOT CMAKE_OSX_SYSROOT OR NOT IS_ABSOLUTE "${CMAKE_OSX_SYSROOT}")
  message(FATAL_ERROR "CMAKE_OSX_SYSROOT must be an explicit absolute SDK path")
endif()
if(NOT CMAKE_OSX_DEPLOYMENT_TARGET STREQUAL "14.0")
  message(FATAL_ERROR "This spike fixes CMAKE_OSX_DEPLOYMENT_TARGET=14.0")
endif()
if(NOT CMAKE_OSX_ARCHITECTURES MATCHES "^(arm64|x86_64)$")
  message(FATAL_ERROR "Build one deterministic arm64 or x86_64 slice at a time")
endif()

foreach(required_file IN ITEMS
    "${VGPU_DAWN_ROOT}/CMakeLists.txt"
    "${VGPU_JSONCPP_ROOT}/include/json/json.h"
    "${VGPU_JSONCPP_ROOT}/src/lib_json/json_reader.cpp"
    "${VGPU_JSONCPP_ROOT}/src/lib_json/json_value.cpp"
    "${VGPU_JSONCPP_ROOT}/src/lib_json/json_writer.cpp"
    "${VGPU_WORKER_ROOT}/main.cc"
    "${VGPU_WORKER_ROOT}/json-codec.cc"
    "${VGPU_WORKER_ROOT}/json-codec.h"
    "${VGPU_WORKER_ROOT}/request.h")
  if(NOT EXISTS "${required_file}")
    message(FATAL_ERROR "Required source is missing: ${required_file}")
  endif()
endforeach()

# The gate is deliberately offline. All source roots must already exist, and
# CMake package registries cannot fill in an omitted dependency implicitly.
set(FETCHCONTENT_FULLY_DISCONNECTED ON CACHE BOOL "" FORCE)
set(FETCHCONTENT_UPDATES_DISCONNECTED ON CACHE BOOL "" FORCE)
set(CMAKE_FIND_USE_PACKAGE_REGISTRY OFF CACHE BOOL "" FORCE)
set(CMAKE_FIND_USE_SYSTEM_PACKAGE_REGISTRY OFF CACHE BOOL "" FORCE)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Tint uses __FILE__ in diagnostics and assertions. Normalize every physical
# source/build prefix before compiling so release binaries neither disclose the
# checkout location nor change when the same inputs are materialized elsewhere.
set(VGPU_PREFIX_MAPS
  "${VGPU_DAWN_ROOT}=/vgpu/source/dawn"
  "${VGPU_JSONCPP_ROOT}=/vgpu/source/jsoncpp"
  "${VGPU_WORKER_ROOT}=/vgpu/source/worker"
  "${CMAKE_BINARY_DIR}=/vgpu/build")
foreach(prefix_map IN LISTS VGPU_PREFIX_MAPS)
  add_compile_options(
    "$<$<COMPILE_LANG_AND_ID:C,AppleClang,Clang>:-ffile-prefix-map=${prefix_map}>"
    "$<$<COMPILE_LANG_AND_ID:C,AppleClang,Clang>:-fmacro-prefix-map=${prefix_map}>"
    "$<$<COMPILE_LANG_AND_ID:CXX,AppleClang,Clang>:-ffile-prefix-map=${prefix_map}>"
    "$<$<COMPILE_LANG_AND_ID:CXX,AppleClang,Clang>:-fmacro-prefix-map=${prefix_map}>")
endforeach()

# Build Tint as direct static targets. Do not build Dawn's distributable
# monolith, runtime backends, WebGPU implementation, tools, or test surfaces.
set(DAWN_FETCH_DEPENDENCIES OFF CACHE BOOL "" FORCE)
set(DAWN_BUILD_MONOLITHIC_LIBRARY OFF CACHE STRING "" FORCE)
set(DAWN_BUILD_SAMPLES OFF CACHE BOOL "" FORCE)
set(DAWN_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(DAWN_BUILD_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(DAWN_BUILD_PROTOBUF OFF CACHE BOOL "" FORCE)
set(DAWN_BUILD_FUZZERS OFF CACHE BOOL "" FORCE)
set(DAWN_BUILD_NODE_BINDINGS OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(DAWN_ALWAYS_ASSERT OFF CACHE BOOL "" FORCE)
set(DAWN_EMIT_COVERAGE OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_ASAN OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_MSAN OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_TSAN OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_UBSAN OFF CACHE BOOL "" FORCE)
set(DAWN_FORCE_SYSTEM_COMPONENT_LOAD OFF CACHE BOOL "" FORCE)
set(DAWN_WERROR OFF CACHE BOOL "" FORCE)
set(DAWN_WEVERYTHING OFF CACHE BOOL "" FORCE)

set(DAWN_ENABLE_D3D11 OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_D3D12 OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_DESKTOP_GL OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_METAL OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_NULL OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_OPENGLES OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_SPIRV_VALIDATION OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_SWIFTSHADER OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_VULKAN OFF CACHE BOOL "" FORCE)
set(DAWN_ENABLE_WEBGPU_ON_WEBGPU OFF CACHE BOOL "" FORCE)
set(DAWN_USE_AGILITY_SDK OFF CACHE BOOL "" FORCE)
set(DAWN_USE_BUILT_DXC OFF CACHE BOOL "" FORCE)
set(DAWN_USE_GLFW OFF CACHE BOOL "" FORCE)
set(DAWN_USE_WAYLAND OFF CACHE BOOL "" FORCE)
set(DAWN_USE_WINDOWS_UI OFF CACHE BOOL "" FORCE)
set(DAWN_USE_X11 OFF CACHE BOOL "" FORCE)

set(TINT_BUILD_AS_OTHER_OS OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_CMD_TOOLS OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_FUZZERS OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_FUZZER_VULKAN_SUPPORT OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_GLSL_VALIDATOR OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_GLSL_WRITER OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_HLSL_WRITER OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_IR_BINARY OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_MESA OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_MSL_WRITER ON CACHE BOOL "" FORCE)
set(TINT_BUILD_NULL_WRITER OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_SPV_READER OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_SPV_WRITER OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(TINT_BUILD_WGSL_READER ON CACHE BOOL "" FORCE)
set(TINT_BUILD_WGSL_WRITER OFF CACHE BOOL "" FORCE)
set(TINT_ENABLE_IR_DUMPING OFF CACHE BOOL "" FORCE)
set(TINT_ENABLE_IR_VALIDATION_ASSERTS OFF CACHE BOOL "" FORCE)
set(TINT_ENABLE_BREAK_IN_DEBUGGER OFF CACHE BOOL "" FORCE)
set(TINT_RANDOMIZE_HASHES OFF CACHE BOOL "" FORCE)

set(ABSL_BUILD_MONOLITHIC_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(ABSL_BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(ABSL_BUILD_TEST_HELPERS OFF CACHE BOOL "" FORCE)
set(ABSL_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(ABSL_PROPAGATE_CXX_STD ON CACHE BOOL "" FORCE)

add_subdirectory("${VGPU_DAWN_ROOT}" dawn EXCLUDE_FROM_ALL)

add_executable(vgpu-tint-worker
  "${VGPU_WORKER_ROOT}/main.cc"
  "${VGPU_WORKER_ROOT}/json-codec.cc"
  "${VGPU_JSONCPP_ROOT}/src/lib_json/json_reader.cpp"
  "${VGPU_JSONCPP_ROOT}/src/lib_json/json_value.cpp"
  "${VGPU_JSONCPP_ROOT}/src/lib_json/json_writer.cpp")

set_target_properties(vgpu-tint-worker PROPERTIES
  CXX_EXTENSIONS OFF
  CXX_STANDARD 20
  CXX_STANDARD_REQUIRED ON)

target_compile_options(vgpu-tint-worker PRIVATE
  $<$<COMPILE_LANG_AND_ID:CXX,AppleClang,Clang>:-Wall;-Wextra;-Wpedantic;-Werror>)

target_include_directories(vgpu-tint-worker PRIVATE
  "${VGPU_WORKER_ROOT}"
  "${VGPU_JSONCPP_ROOT}/include"
  "${VGPU_JSONCPP_ROOT}/src/lib_json")

# tint_api is the sole declared link root. Its CMake usage requirements carry
# the precise WGSL-reader/MSL-writer static target closure.
target_link_libraries(vgpu-tint-worker PRIVATE tint_api)
