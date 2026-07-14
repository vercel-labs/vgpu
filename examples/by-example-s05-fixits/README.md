# by-example §5 fix-it errors

This example uses `vgpu/mock` on purpose so it can run locally without a GPU. It exercises developer-facing fix-it messages for two canonical mistakes: drawing with a required binding that was never set, and violating R1 by flipping a binding from lib-owned JS values to a user-owned resource.

## Run it

```bash
pnpm exec vitest run examples/by-example-s05-fixits
```

No Docker GPU harness is required for this example because the mock entrypoint is enough to validate reflection, ownership checks, and error text.

## What to expect

The test collects thrown messages and asserts they name the missing binding case (`nunca fue seteado`) and the ownership-flip case (`No se puede cambiar el ownership`). The example should fail loudly if those fix-its regress.
