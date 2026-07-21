# Audited glibc 2.31 build userspace for webgpu@0.4.0 / node-webgpu.
FROM ubuntu:20.04@sha256:8feb4d8ca5354def3d8fce243717141ce31e2c428701f6682bd2fafe15388214

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=20.20.0
ARG GO_VERSION=1.21.3
ARG CMAKE_VERSION=3.31.6
ARG MINICONDA=Miniconda3-py311_25.1.1-2-Linux-aarch64.sh
ARG NODE_WEBGPU_REF=2f5fb632d9d9db9bcb3705bd868de69a6a2ae4e2
ARG DAWN_REF=c5d549e250b9225744929ae860b369cb4304a767
ARG DEPOT_TOOLS_REF=8e07900125ba28f056008bded80053b297837aab

LABEL org.opencontainers.image.source="https://github.com/vercel-labs/vgpu" \
      dev.vgpu.webgpu-version="0.4.0" \
      dev.vgpu.node-webgpu-ref="${NODE_WEBGPU_REF}" \
      dev.vgpu.dawn-ref="${DAWN_REF}" \
      dev.vgpu.depot-tools-ref="${DEPOT_TOOLS_REF}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git xz-utils software-properties-common \
    python3 python3-distutils pkg-config cmake ninja-build time binutils file \
    libxrandr-dev libxinerama-dev libxcursor-dev mesa-common-dev libx11-xcb-dev \
    libvulkan-dev \
 && add-apt-repository -y ppa:ubuntu-toolchain-r/test \
 && apt-get update \
 && apt-get install -y --no-install-recommends gcc-12 g++-12 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLO https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz \
 && tar -xJf node-v${NODE_VERSION}-linux-arm64.tar.xz -C /usr/local --strip-components=1 \
 && rm node-v${NODE_VERSION}-linux-arm64.tar.xz \
 && curl -fsSLO https://go.dev/dl/go${GO_VERSION}.linux-arm64.tar.gz \
 && tar -xzf go${GO_VERSION}.linux-arm64.tar.gz -C /usr/local \
 && rm go${GO_VERSION}.linux-arm64.tar.gz \
 && curl -fsSLO https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-aarch64.tar.gz \
 && tar -xzf cmake-${CMAKE_VERSION}-linux-aarch64.tar.gz -C /opt \
 && ln -sf /opt/cmake-${CMAKE_VERSION}-linux-aarch64/bin/* /usr/local/bin/ \
 && rm cmake-${CMAKE_VERSION}-linux-aarch64.tar.gz \
 && curl -fsSLO https://repo.anaconda.com/miniconda/${MINICONDA} \
 && bash ${MINICONDA} -b -p /opt/miniconda \
 && rm ${MINICONDA}

ENV PATH=/opt/miniconda/bin:/usr/local/go/bin:$PATH \
    CC=gcc-12 \
    CXX=g++-12 \
    LDFLAGS="-static-libstdc++ -static-libgcc" \
    DEPOT_TOOLS_UPDATE=0 \
    DEPOT_TOOLS_WIN_TOOLCHAIN=0

WORKDIR /src
RUN git clone https://github.com/dawn-gpu/node-webgpu.git . \
 && git checkout ${NODE_WEBGPU_REF} \
 && test "$(git rev-parse HEAD)" = "${NODE_WEBGPU_REF}" \
 && npm ci

RUN bash -o pipefail -c '/usr/bin/time -v npm run build 2>&1 | tee /tmp/build.log' \
 && test "$(git -C third_party/dawn rev-parse HEAD)" = "${DAWN_REF}" \
 && test "$(git -C third_party/depot_tools rev-parse HEAD)" = "${DEPOT_TOOLS_REF}"

RUN mkdir -p /out \
 && cp dist/linux-arm64.dawn.node /out/dawn-linux-arm64-gnu.node \
 && cp /tmp/build.log /out/build.log \
 && printf '%s\n' \
      'package: webgpu@0.4.0' \
      "node-webgpu git: ${NODE_WEBGPU_REF}" \
      "Dawn git: ${DAWN_REF}" \
      "depot_tools git: ${DEPOT_TOOLS_REF}" \
      'build userspace: ubuntu:20.04@sha256:8feb4d8ca5354def3d8fce243717141ce31e2c428701f6682bd2fafe15388214' \
      'compiler: GCC/G++ 12; static libstdc++ and libgcc' \
      "CMake: ${CMAKE_VERSION} linux-aarch64" \
      'Python: Miniconda Python 3.11' \
      "Node: ${NODE_VERSION} linux-arm64" \
      > /out/source-manifest.txt \
 && readelf --version-info /out/dawn-linux-arm64-gnu.node > /out/readelf-version-info.txt \
 && readelf -d /out/dawn-linux-arm64-gnu.node > /out/readelf-dynamic.txt \
 && sha256sum /out/dawn-linux-arm64-gnu.node | sed 's#  /out/#  #' > /out/SHA256SUMS
