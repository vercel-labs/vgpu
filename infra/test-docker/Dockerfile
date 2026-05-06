FROM node:22-trixie-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    XDG_RUNTIME_DIR=/tmp/xdg-runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libegl-dev \
    libegl1 \
    libgl1 \
    libgl1-mesa-dri \
    libglx-mesa0 \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /tmp/xdg-runtime && chmod 700 /tmp/xdg-runtime

WORKDIR /workspace
COPY . .
RUN corepack enable
RUN pnpm install --frozen-lockfile
RUN pnpm typecheck
RUN Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 & \
    xvfb_pid=$!; \
    pnpm test; \
    status=$?; \
    kill $xvfb_pid; \
    exit $status
