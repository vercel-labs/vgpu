import fs from "node:fs";
import path from "node:path";
import fontkit from "fontkit";

export type GlyphDots = {
  readonly dots: readonly (readonly [number, number])[];
  readonly cols: number;
  readonly rows: number;
  readonly startCol: number;
  readonly startRow: number;
  readonly advance: number;
  readonly bbox: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
};

export type DotMap = Record<string, GlyphDots>;

export type DotMapResult = {
  readonly dotMap: DotMap;
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
};

export const CELL_PITCH = 38;

type PathCommand = {
  readonly command: string;
  readonly args: readonly number[];
};

function pointInPath(commands: readonly PathCommand[], px: number, py: number) {
  let inside = false;
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;

  function testEdge(x1: number, y1: number, x2: number, y2: number) {
    if ((y1 > py) !== (y2 > py)) {
      const xIntersect = x1 + ((py - y1) / (y2 - y1)) * (x2 - x1);
      if (px < xIntersect) inside = !inside;
    }
  }

  for (const cmd of commands) {
    switch (cmd.command) {
      case "moveTo":
        startX = curX = cmd.args[0] ?? 0;
        startY = curY = cmd.args[1] ?? 0;
        break;
      case "lineTo":
        testEdge(curX, curY, cmd.args[0] ?? 0, cmd.args[1] ?? 0);
        curX = cmd.args[0] ?? 0;
        curY = cmd.args[1] ?? 0;
        break;
      case "quadraticCurveTo":
      case "bezierCurveTo":
        // Geist Pixel glyphs are rectilinear; approximate unsupported curves by their endpoint.
        {
          const x = cmd.args[cmd.args.length - 2] ?? curX;
          const y = cmd.args[cmd.args.length - 1] ?? curY;
          testEdge(curX, curY, x, y);
          curX = x;
          curY = y;
        }
        break;
      case "closePath":
        testEdge(curX, curY, startX, startY);
        curX = startX;
        curY = startY;
        break;
    }
  }

  return inside;
}

let cachedFont: fontkit.Font | null = null;
const cache = new Map<string, DotMapResult>();

function getFont() {
  if (!cachedFont) {
    const fontPath = path.join(process.cwd(), "public/fonts/GeistPixel-Square.woff2");
    cachedFont = fontkit.create(fs.readFileSync(fontPath)) as fontkit.Font;
  }
  return cachedFont;
}

function extractGlyphDots(char: string): GlyphDots {
  const font = getFont();
  const glyph = font.glyphForCodePoint(char.codePointAt(0) ?? 0);
  const bbox = {
    minX: glyph.bbox.minX,
    minY: glyph.bbox.minY,
    maxX: glyph.bbox.maxX,
    maxY: glyph.bbox.maxY,
  };
  const startRow = Math.floor(bbox.minY / CELL_PITCH);
  const endRow = Math.ceil(bbox.maxY / CELL_PITCH);
  const startCol = Math.floor(bbox.minX / CELL_PITCH);
  const endCol = Math.ceil(bbox.maxX / CELL_PITCH);
  const dots: [number, number][] = [];
  const commands = glyph.path.commands as PathCommand[];

  for (let row = startRow; row < endRow; row++) {
    for (let col = startCol; col < endCol; col++) {
      const px = col * CELL_PITCH + CELL_PITCH / 2;
      const py = row * CELL_PITCH + CELL_PITCH / 2;
      if (pointInPath(commands, px, py)) {
        dots.push([col, row]);
      }
    }
  }

  return {
    dots,
    cols: endCol - startCol,
    rows: endRow - startRow,
    startCol,
    startRow,
    advance: glyph.advanceWidth,
    bbox,
  };
}

export async function getDotMap(text: string): Promise<DotMapResult> {
  const cached = cache.get(text);
  if (cached) return cached;

  const uniqueChars = [...new Set(text.split(""))].filter((char) => char !== " ");
  const dotMap: DotMap = {};
  for (const char of uniqueChars) {
    dotMap[char] = extractGlyphDots(char);
  }

  const font = getFont();
  const result: DotMapResult = {
    dotMap,
    unitsPerEm: font.unitsPerEm,
    ascent: font.ascent,
    descent: font.descent,
  };
  cache.set(text, result);
  return result;
}
