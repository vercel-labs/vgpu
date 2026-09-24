// The eight cards are the demo's own ingredients: four vgpu primitives that draw
// the liquid and four Motion features that move it. `hue` picks the liquid tint
// (0 azure, 1 magenta); bridges between the two blend through violet.

export type CardLibrary = 'vgpu' | 'motion';

export interface CardData {
  readonly id: string;
  readonly library: CardLibrary;
  readonly title: string;
  readonly line: string;
  readonly detail: string;
  readonly code: string;
  readonly hue: number;
}

export const CARDS: readonly CardData[] = [
  {
    id: 'surface',
    library: 'vgpu',
    title: 'surface',
    line: 'The canvas target. It tracks DPR and resizes at the frame boundary.',
    detail:
      'The liquid renders into one surface with a DPR clamped to [1, 2]. Resizes land at the frame boundary, and onResize rebuilds the offscreen chain in the same frame.',
    code: 'surface(gpu, canvas, { dpr: [1, 2] })',
    hue: 0,
  },
  {
    id: 'effect',
    library: 'vgpu',
    title: 'effect',
    line: 'Fullscreen fragment passes. This liquid chains nine of them.',
    detail:
      'The backdrop, the distance field, the glass shading, the bloom and the tonemap are all effects. Card rects, velocities and drips reach the field as a single uniform array.',
    code: "effect(gpu, fieldWgsl, { set: { field } })",
    hue: 0,
  },
  {
    id: 'target',
    library: 'vgpu',
    title: 'target',
    line: 'Offscreen HDR textures that the next pass samples.',
    detail:
      'rgba16float targets hold the field and the lit liquid. Refraction samples the backdrop through the field normal, one tap per colour channel.',
    code: "target(gpu, { size, format: 'rgba16float' })",
    hue: 0,
  },
  {
    id: 'frame',
    library: 'vgpu',
    title: 'frame',
    line: "One encoder and one submit per tick, timed by Motion's clock.",
    detail:
      'No frameLoop here. Motion owns the frameloop: each postRender reads the laid-out cards, advances the vgpu clock by the same delta and encodes the frame.',
    code: 'frame.postRender(tick, true)',
    hue: 0,
  },
  {
    id: 'layout',
    library: 'motion',
    title: 'layout',
    line: 'FLIP shuffles. The liquid bridges passing cards and snaps apart.',
    detail:
      'Every card has the layout prop, so reorders animate with transforms. Each blob gets softer as it speeds up, so cards that pass each other merge for a moment.',
    code: '<motion.button layout />',
    hue: 1,
  },
  {
    id: 'layoutId',
    library: 'motion',
    title: 'layoutId',
    line: 'Shared element transitions. Click a card to open it.',
    detail:
      'The grid card and this panel share a layoutId. The blob follows the transition onto its own layer, and the change in size kicks its jelly spring.',
    code: '<motion.div layoutId={card.id} />',
    hue: 1,
  },
  {
    id: 'drag',
    library: 'motion',
    title: 'drag',
    line: 'Pull a card. A tether stretches back to its slot.',
    detail:
      'dragSnapToOrigin springs the card home. Until it lands, a capsule of liquid joins it to its empty slot and thins as it stretches. The drag velocity also tilts the card.',
    code: '<motion.button drag dragSnapToOrigin />',
    hue: 1,
  },
  {
    id: 'presence',
    library: 'motion',
    title: 'AnimatePresence',
    line: 'Filter the grid. Cards drip away and re-form.',
    detail:
      'A card that exits hands its blob to a drip: it drains, necks and falls. A card that enters falls into its slot as a droplet and splashes into shape.',
    code: '<AnimatePresence mode="popLayout" />',
    hue: 1,
  },
];

export const CARD_BY_ID: ReadonlyMap<string, CardData> = new Map(CARDS.map((card) => [card.id, card]));
