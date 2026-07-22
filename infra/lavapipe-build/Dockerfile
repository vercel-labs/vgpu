# syntax=docker/dockerfile:1
ARG DEBIAN_RELEASE=trixie
FROM debian:${DEBIAN_RELEASE} AS build
ARG MESA_VERSION=25.0.7
ARG MESA_SHA256=592272df3cf01e85e7db300c449df5061092574d099da275d19e97ef0510f8a6
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl xz-utils build-essential meson ninja-build pkg-config \
    python3 python3-mako python3-yaml python3-packaging flex bison gettext \
    llvm-19-dev libclang-cpp19-dev libpolly-19-dev libdrm-dev libudev-dev libexpat1-dev libelf-dev \
    libunwind-dev libzstd-dev zlib1g-dev libxml2-dev libffi-dev libedit-dev libncurses-dev \
    libvulkan-dev glslang-tools glslang-dev spirv-tools
WORKDIR /src
RUN curl -fsSLO "https://archive.mesa3d.org/mesa-${MESA_VERSION}.tar.xz" \
 && echo "${MESA_SHA256}  mesa-${MESA_VERSION}.tar.xz" | sha256sum -c - \
 && tar -xf "mesa-${MESA_VERSION}.tar.xz"
WORKDIR /src/mesa-${MESA_VERSION}
RUN meson setup build --prefix=/opt/lavapipe --libdir=lib --buildtype=release \
    -Db_lto=true -Db_ndebug=true -Dstrip=true \
    -Dvulkan-drivers=swrast -Dgallium-drivers=llvmpipe -Dshared-llvm=disabled \
    -Dglx=disabled -Degl=disabled -Dgbm=disabled -Dplatforms=[] \
    -Dgles1=disabled -Dgles2=disabled -Dopengl=false -Dglvnd=disabled \
    -Dllvm=enabled -Dshared-glapi=disabled -Dvalgrind=disabled \
    -Dlibunwind=disabled -Dlmsensors=disabled -Dzstd=disabled \
    -Dbuild-tests=false -Dinstall-mesa-clc=false \
 && ninja -C build -v \
 && ninja -C build install
RUN mkdir -p /out \
 && cp /opt/lavapipe/lib/libvulkan_lvp.so /out/libvulkan_lvp.so \
 && printf '{\n  "file_format_version": "1.0.0",\n  "ICD": {\n    "library_path": "./libvulkan_lvp.so",\n    "api_version": "1.4.305"\n  }\n}\n' > /out/lvp_icd.json \
 && strip --strip-unneeded /out/libvulkan_lvp.so \
 && llvm-config-19 --link-static --libs native engine mcjit orcjit core analysis scalaropts transformutils instcombine target bitreader bitwriter irreader asmparser > /out/llvm-static-link-libs.txt \
 && ldd /out/libvulkan_lvp.so > /out/ldd.txt \
 && readelf -d /out/libvulkan_lvp.so > /out/readelf-dynamic.txt

FROM debian:${DEBIAN_RELEASE} AS artifact
ARG MESA_VERSION
LABEL org.opencontainers.image.title="vgpu Lavapipe build" \
      org.opencontainers.image.version="${MESA_VERSION}" \
      org.opencontainers.image.source="https://github.com/vercel-labs/vgpu"
COPY --from=build /out /out
