# syntax=docker/dockerfile:1
# Debian 11 supplies the GLIBC 2.31 compatibility floor. LLVM 19 comes from
# apt.llvm.org's official Bullseye repository because Bullseye predates LLVM 19.
ARG DEBIAN_RELEASE=bullseye-slim
FROM debian:${DEBIAN_RELEASE} AS build
ARG MESA_VERSION=25.0.7
ARG MESA_SHA256=592272df3cf01e85e7db300c449df5061092574d099da275d19e97ef0510f8a6
ARG LIBDRM_VERSION=2.4.124
ARG LIBDRM_SHA256=ac36293f61ca4aafaf4b16a2a7afff312aa4f5c37c9fbd797de9e3c0863ca379
ENV DEBIAN_FRONTEND=noninteractive \
    LDFLAGS="-static-libstdc++ -static-libgcc"
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg \
 && curl -fsSL https://apt.llvm.org/llvm-snapshot.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/apt.llvm.org.gpg \
 && echo 'deb [signed-by=/usr/share/keyrings/apt.llvm.org.gpg] https://apt.llvm.org/bullseye/ llvm-toolchain-bullseye-19 main' \
    > /etc/apt/sources.list.d/llvm.list \
 && apt-get update && apt-get install -y --no-install-recommends \
    xz-utils build-essential ninja-build pkg-config binutils \
    python3 python3-pip python3-mako python3-yaml python3-packaging flex bison gettext \
    llvm-19-dev libclang-cpp19-dev libpolly-19-dev libdrm-dev libudev-dev libexpat1-dev libelf-dev \
    libunwind-dev libzstd-dev zlib1g-dev libxml2-dev libffi-dev libedit-dev libncurses-dev \
    libvulkan-dev glslang-tools glslang-dev spirv-tools \
 && pip3 install --no-cache-dir meson==1.7.0
WORKDIR /src
# Mesa 25 requires libdrm >= 2.4.109; Bullseye ships 2.4.104. Build the
# pinned newer libdrm in the old userspace so it retains the GLIBC 2.31 floor.
RUN curl -fsSLO "https://dri.freedesktop.org/libdrm/libdrm-${LIBDRM_VERSION}.tar.xz" \
 && echo "${LIBDRM_SHA256}  libdrm-${LIBDRM_VERSION}.tar.xz" | sha256sum -c - \
 && tar -xf "libdrm-${LIBDRM_VERSION}.tar.xz" \
 && meson setup libdrm-build "libdrm-${LIBDRM_VERSION}" --prefix=/usr/local --libdir=lib \
    -Dtests=false -Dman-pages=disabled \
 && ninja -C libdrm-build \
 && ninja -C libdrm-build install \
 && ldconfig
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
 && readelf -d /out/libvulkan_lvp.so > /out/readelf-dynamic.txt \
 && readelf --version-info /out/libvulkan_lvp.so > /out/readelf-version-info.txt \
 && objdump -T /out/libvulkan_lvp.so > /out/objdump-dynamic-symbols.txt \
 && max_glibc=$(grep -o 'GLIBC_[0-9.]*' /out/objdump-dynamic-symbols.txt | sort -V | tail -1) \
 && test "$(printf '%s\n' GLIBC_2.31 "$max_glibc" | sort -V | tail -1)" = GLIBC_2.31 \
 && max_glibcxx=$(grep -o 'GLIBCXX_[0-9.]*' /out/objdump-dynamic-symbols.txt | sort -V | tail -1 || true) \
 && test -z "$max_glibcxx" \
 && max_cxxabi=$(grep -o 'CXXABI_[0-9.]*' /out/objdump-dynamic-symbols.txt | sort -V | tail -1 || true) \
 && test -z "$max_cxxabi" \
 && printf 'GLIBC=%s\nGLIBCXX=none (static libstdc++)\nCXXABI=none (static libstdc++)\n' "$max_glibc" > /out/symbol-version-floor.txt

FROM debian:${DEBIAN_RELEASE} AS artifact
ARG MESA_VERSION
LABEL org.opencontainers.image.title="vgpu Lavapipe build" \
      org.opencontainers.image.version="${MESA_VERSION}" \
      org.opencontainers.image.source="https://github.com/vercel-labs/vgpu" \
      dev.vgpu.glibc-floor="2.31"
COPY --from=build /out /out
