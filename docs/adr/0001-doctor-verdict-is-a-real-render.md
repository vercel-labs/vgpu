# ADR 0001: Doctor's verdict is a real render

## Status

Accepted

## Context

Two external agents misdiagnosed "adapter unavailable" as hard sandbox limitations. Static environment checks can pass while Dawn still rejects the stack because of feature-level requirements.

## Decision

`vgpu doctor`'s verdict is produced by actually rendering (init → draw → readback → dispose), not by static checks. Static probes exist to explain failures, not to declare health.

## Consequences

A doctor run costs approximately 1–3 seconds with a cached binary and may download the Dawn prebuild on first run; that acquisition is reported as a finding. `--no-render` yields an explicitly `unverified` verdict. The render path also serves as a permanent end-to-end regression of acquisition and teardown.
