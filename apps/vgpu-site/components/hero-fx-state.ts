export type HeroFxDot = {
  readonly x: number;
  readonly y: number;
  readonly morph: number;
  readonly visible: number;
};

export type HeroFxState = {
  readonly dots: readonly HeroFxDot[];
  readonly color: string;
};

const state: HeroFxState = {
  dots: [],
  color: "#a1a1aa",
};

export function publishHeroFxState(nextState: HeroFxState) {
  (state as { dots: readonly HeroFxDot[]; color: string }).dots = nextState.dots;
  (state as { dots: readonly HeroFxDot[]; color: string }).color = nextState.color;
}

export function readHeroFxState() {
  return state;
}
