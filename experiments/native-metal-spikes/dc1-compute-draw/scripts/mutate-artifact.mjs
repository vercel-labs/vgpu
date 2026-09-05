#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const arguments_ = process.argv.slice(2);
if (
  arguments_.length !== 6 ||
  arguments_[0] !== "--artifact" ||
  arguments_[2] !== "--generated" ||
  arguments_[4] !== "--mutation"
) {
  usage();
}
const artifactPath = resolve(arguments_[1]);
const generatedPath = resolve(arguments_[3]);
const mutation = arguments_[5];
const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

switch (mutation) {
  case "abi":
    artifact.abi.bindingLayoutABI = 2;
    break;
  case "artifact-id":
    artifact.artifactID = "dc1-compute-draw-mutated";
    break;
  case "entry-point":
    artifact.programs[1].entryPointIDs.compute = "mutated";
    break;
  case "fixed-layout":
    artifact.programs[1].runtimeManifest.bindings[0].descriptor.minimumBindingSize = 28;
    break;
  case "fractional-integer":
    artifact.schemaVersion = 1.5;
    break;
  case "model":
    artifact.programs[1].runtimeManifest.storageBufferSizeModel =
      "vgpu-metal-slot-indexed-storage-buffer-byte-sizes-v2";
    break;
  case "program-order":
    artifact.programs.reverse();
    break;
  case "unknown":
    artifact.unexpected = true;
    break;
  case "unicode-digest":
    artifact.semantic.sha256 = "ａ".repeat(64);
    break;
  default:
    usage();
}

const descriptorBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
const descriptorSHA256 = createHash("sha256")
  .update(descriptorBytes)
  .digest("hex");
const generated = readFileSync(generatedPath, "utf8");
const pattern = /(_vgpuDescriptorSHA256 = ")[a-f0-9]{64}("\n)/u;
if ((generated.match(new RegExp(pattern.source, "gu")) ?? []).length !== 1) {
  fail("generated witness must contain exactly one descriptor digest");
}

writeFileSync(artifactPath, descriptorBytes);
writeFileSync(
  generatedPath,
  generated.replace(pattern, `$1${descriptorSHA256}$2`),
  "utf8"
);
process.stdout.write(`${JSON.stringify({ descriptorSHA256, mutation })}\n`);

function usage() {
  fail(
    "usage: mutate-artifact.mjs --artifact <artifact.json> --generated <generated.swift> --mutation <abi|artifact-id|entry-point|fixed-layout|fractional-integer|model|program-order|unicode-digest|unknown>"
  );
}

function fail(message) {
  process.stderr.write(`dc1-compute-draw mutation helper: ${message}\n`);
  process.exit(1);
}
