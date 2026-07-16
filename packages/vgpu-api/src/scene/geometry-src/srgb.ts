type SrgbInput = number | [number, number, number];
type LinearRgb = [number, number, number];

export function srgb(input: SrgbInput): LinearRgb {
  const channels = typeof input === "number" ? hexToChannels(input) : input;
  return [toLinear(channels[0]), toLinear(channels[1]), toLinear(channels[2])];
}

function hexToChannels(hex: number): LinearRgb {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}
