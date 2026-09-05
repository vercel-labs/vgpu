@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read> mask: array<u32>;
@group(0) @binding(2) var<storage, read_write> dst: array<u32>;
@group(0) @binding(3) var<storage, read_write> advanceAudit: array<u32>;
@group(0) @binding(4) var<storage, read_write> mixAudit: array<u32>;

@compute @workgroup_size(2, 1, 1)
fn advance(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(num_workgroups) groups: vec3<u32>,
) {
  let index = id.x + id.z * (groups.x * 2u);
  if (index >= arrayLength(&dst)) {
    return;
  }

  dst[index] = src[index] * 2u + (mask[index] - src[index]) + 1u;
  if (index == 0u) {
    advanceAudit[0] = 101u;
    advanceAudit[1] = groups.x;
    advanceAudit[2] = groups.y;
    advanceAudit[3] = groups.z;
  }
}

@compute @workgroup_size(1, 2, 1)
fn mix(
  @builtin(global_invocation_id) id: vec3<u32>,
  @builtin(num_workgroups) groups: vec3<u32>,
) {
  let index = id.y * groups.x + id.x;
  if (index >= arrayLength(&dst)) {
    return;
  }

  dst[index] = src[index] * 2u + mask[index] * 2u + 2u;
  if (index == 0u) {
    mixAudit[0] = 202u;
    mixAudit[1] = groups.x;
    mixAudit[2] = groups.y;
    mixAudit[3] = groups.z;
  }
}
