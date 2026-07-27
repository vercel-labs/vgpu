import { invalidUsage } from "./errors.ts";

type SrgbInput = number | string | [number, number, number];
type LinearRgb = [number, number, number];

export function srgb(input: SrgbInput): LinearRgb {
  const channels = typeof input === "number"
    ? hexToChannels(input)
    : typeof input === "string"
      ? hexStringToChannels(input)
      : input;
  return [toLinear(channels[0]), toLinear(channels[1]), toLinear(channels[2])];
}

function hexToChannels(hex: number): LinearRgb {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

function hexStringToChannels(hex: string): LinearRgb {
  const digits = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-fA-F]{6}$/u.test(digits)) {
    throw invalidUsage("srgb", `Invalid hex color '${hex}'; expected "#rrggbb" (e.g. "#ff8040").`);
  }
  return hexToChannels(Number.parseInt(digits, 16));
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
