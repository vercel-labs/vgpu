FROM node:22-trixie-slim
LABEL vgpu-test=1

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    DEBIAN_FRONTEND=noninteractive \
    VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json \
    VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json \
    XDG_RUNTIME_DIR=/tmp/xdg-runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libvulkan1 \
    mesa-vulkan-drivers \
    vulkan-tools \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /tmp/xdg-runtime && chmod 700 /tmp/xdg-runtime

WORKDIR /workspace
COPY . .
RUN corepack enable
RUN pnpm config set network-timeout 120000 \
 && pnpm config set fetch-retries 5 \
 && pnpm config set fetch-retry-mintimeout 10000 \
 && pnpm config set fetch-retry-maxtimeout 60000 \
 && pnpm install --frozen-lockfile
RUN pnpm typecheck
RUN pnpm test
