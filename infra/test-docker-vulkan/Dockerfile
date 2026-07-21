FROM node:24-trixie-slim
LABEL vgpu-test=1
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 DEBIAN_FRONTEND=noninteractive XDG_RUNTIME_DIR=/tmp/xdg-runtime VGPU_CACHE_DIR=/tmp/vgpu-cache
RUN apt-get update && apt-get install -y --no-install-recommends mesa-vulkan-drivers vulkan-tools && mkdir -p /tmp/xdg-runtime && chmod 700 /tmp/xdg-runtime
WORKDIR /workspace
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build
CMD ["bash", "infra/test-docker-vulkan/test.sh"]
