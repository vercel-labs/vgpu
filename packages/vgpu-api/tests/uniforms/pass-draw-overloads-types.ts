import type { Draw, Effect, Frame, Target } from "../../src/index.ts";

declare const target: Target;
declare const effect: Effect;
declare const draw: Draw;
declare const frame: Frame;

effect.draw(target);
effect.draw({ target, instances: 2 });
draw.draw(target);
draw.draw({ target, instances: 2 });
frame.pass(target, effect);
frame.pass(target, draw);
frame.pass(target, (pass) => pass.draw(effect));
frame.pass({ target, clear: [0, 0, 0, 1] }, effect);

// @ts-expect-error numbers are not valid draw targets or draw option bags.
effect.draw(42);
// @ts-expect-error numbers are not valid draw targets or draw option bags.
draw.draw(42);
// @ts-expect-error frame.pass still needs an explicit target or options bag.
frame.pass((pass) => pass.draw(effect));
