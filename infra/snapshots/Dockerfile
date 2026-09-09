# Canonical visual-test environment. Updating either pin requires reviewed snapshots.
# This is the amd64 manifest of node:22-trixie-slim (Node 22.23.2), not a moving tag.
FROM node@sha256:a05717adfe7289e2a0fa36a694dc430a510adab6467c7036e51551198935abef

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    DEBIAN_FRONTEND=noninteractive \
    VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json \
    VK_DRIVER_FILES=/usr/share/vulkan/icd.d/lvp_icd.json \
    VGPU_DAWN_FLAGS=backend=vulkan \
    VGPU_SNAPSHOT_ENV=linux-x64-vulkan-v1 \
    XDG_RUNTIME_DIR=/tmp/xdg-runtime

# Freeze the complete apt dependency graph, including LLVM, not just Mesa's version.
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260901T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260901T000000Z|g' \
      /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends ca-certificates libvulkan1 \
      mesa-vulkan-drivers=25.0.7-2+deb13u1 vulkan-tools \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/xdg-runtime && chmod 700 /tmp/xdg-runtime \
 && corepack enable

WORKDIR /workspace
