#!/usr/bin/env node

const VERSION = "0.0.5";

const help = `vgpu ${VERSION}

Official VGPU CLI placeholder.

The VGPU runtime libraries are available today under @vgpu/*:
  - @vgpu/core
  - @vgpu/render
  - @vgpu/wgsl
  - @vgpu/adapter-mock
  - @vgpu/adapter-node

Future CLI commands may include:
  - vgpu docs
  - vgpu doctor
  - WGSL utilities

For now, install and use the @vgpu/* packages directly.
`;

const comingSoon = (command) => `vgpu ${command} is coming soon.

This package currently reserves the official VGPU CLI name. For now, use the @vgpu/* runtime libraries directly.
Run \`vgpu --help\` for details.
`;

const args = process.argv.slice(2);
const command = args[0];

if (command === undefined || command === "--help" || command === "-h") {
  process.stdout.write(help);
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

if (command === "docs" || command === "doctor" || command === "wgsl") {
  process.stderr.write(comingSoon(command));
  process.exit(1);
}

process.stderr.write(`Unknown vgpu command: ${command}\n\n${help}`);
process.exit(1);
