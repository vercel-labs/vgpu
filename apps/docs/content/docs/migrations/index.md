---
title: "Migrations"
description: "Versioned upgrade instructions for projects using vgpu."
---

Record your project's current version before upgrading. Read each intervening destination-version guide in ascending version order. Choose the stable or release-candidate starting path that applies to your installed version, then follow the ordered steps and verification. Guides describe the net change to the destination, not a chronological replay of changesets. Packages published before these guides were introduced may not contain them.

Use the CLI from the target project's installed package; do not substitute latest or hosted documentation for a selected RC.

```sh
pnpm exec vgpu docs ls /migrations
```

<!-- Generated from migration release records. Do not edit. -->

## Available guides

- [0.5.0](/docs/migrations/0.5.0) — `vgpu docs cat /migrations/0.5.0.docs.md`
