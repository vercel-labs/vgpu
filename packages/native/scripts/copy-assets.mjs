import { copyFile, mkdir } from "node:fs/promises";

const output = new URL("../dist/tooling/", import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(
  new URL("../src/tooling/publication-session.c", import.meta.url),
  new URL("publication-session.c", output)
);
await copyFile(
  new URL("../src/tooling/publication-staging.c", import.meta.url),
  new URL("publication-staging.c", output)
);
