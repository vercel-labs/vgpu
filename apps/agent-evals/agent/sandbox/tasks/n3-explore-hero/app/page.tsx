import { HeroBackground } from "./hero";

export default function Page() {
  return (
    <main className="hero">
      <HeroBackground />
      <h1>Ship graphics that render everywhere</h1>
      <p>An animated aurora background, rendered with WebGPU.</p>
    </main>
  );
}
