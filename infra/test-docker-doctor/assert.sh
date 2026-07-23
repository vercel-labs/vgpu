#!/usr/bin/env bash
set -euo pipefail
mode=$1
if [[ $mode == xvfb ]]; then Xvfb :99 -screen 0 640x480x24 >/tmp/xvfb.log 2>&1 & trap 'kill $!' EXIT; fi
if [[ $mode == vulkan ]]; then
  unset DISPLAY WAYLAND_DISPLAY
  icd=$(find /usr/share/vulkan/icd.d -name 'lvp_icd*.json' | head -1)
  export VK_ICD_FILENAMES=$icd VK_DRIVER_FILES=$icd
  [[ ! -e "$HOME/.cache/vgpu/software-renderer" ]]
fi
set +e
json=$(node packages/vgpu/bin/vgpu.js doctor)
status=$?
set -e
printf '%s\n' "$json"
DOCTOR_JSON=$json MODE=$mode STATUS=$status node --input-type=module <<'NODE'
import assert from "node:assert/strict";
const report = JSON.parse(process.env.DOCTOR_JSON);
const healthy = process.env.MODE !== "broken";
assert.equal(Number(process.env.STATUS), healthy ? 0 : 1);
assert.equal(report.verdict, healthy ? "healthy" : "unhealthy");
if (healthy) {
  assert.ok(report.adapter?.name);
  assert.equal(report.findings.at(-1).probe, "render");
  assert.equal(report.findings.at(-1).status, "ok");
} else {
  const icd = report.findings.find((finding) => finding.probe === "linux-vulkan-icd");
  assert.equal(icd.status, "fail");
  assert.match(icd.prescription, /^run: npx vgpu install-software-renderer/m);
  assert.match(icd.prescription, /Alternative \(system packages\): apt-get update && apt-get install -y libvulkan1 libdrm2 zlib1g libzstd1 libudev1 mesa-vulkan-drivers/);
  assert.equal(report.adapter, null);
}
NODE

if [[ $mode == broken ]]; then
  node packages/vgpu/bin/vgpu.js install-software-renderer
  json=$(node packages/vgpu/bin/vgpu.js doctor)
  DOCTOR_JSON=$json node --input-type=module <<'NODE'
import assert from "node:assert/strict";
const report = JSON.parse(process.env.DOCTOR_JSON);
assert.equal(report.verdict, "healthy");
assert.equal(report.adapter?.type, "cpu");
assert.equal(report.findings.find((finding) => finding.probe === "software-renderer-cache")?.status, "ok");
assert.equal(report.findings.at(-1).status, "ok");
NODE
fi
