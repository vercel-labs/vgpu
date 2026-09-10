---
title: Migrations
summary: Versioned upgrade instructions for projects using vgpu.
keywords: migration, upgrade, breaking changes
---

# Migrations

Record your project's current version before upgrading. Read each intervening destination-version guide in ascending version order, then follow the affected-usage and verification sections. A guide also covers that version's RC cycle: skip steps you already applied. Packages published before these guides were introduced may not contain them.

Use the CLI from the target project's installed package; do not substitute latest or hosted documentation for a selected RC.

```sh
pnpm exec vgpu docs ls /migrations
```

<!-- Generated from migration release records. Do not edit. -->

## Available guides

- [0.5.0](/docs/migrations/0.5.0) — `vgpu docs cat /migrations/0.5.0.docs.md`
