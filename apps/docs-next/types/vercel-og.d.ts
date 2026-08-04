/**
 * `next/og`'s `ImageResponse` (Satori / `@vercel/og`) accepts an extra `tw`
 * attribute on host JSX elements to express styles as Tailwind classes; it's
 * consumed by Satori at render time, not a real DOM attribute. The package
 * ships this exact augmentation itself
 * (`next/dist/compiled/@vercel/og/types.d.ts`), but whether TypeScript loads
 * that file into the program depends on how `next/og`'s types are resolved
 * (`ImageResponse`'s constructor type there is a lazy `typeof import(...)`
 * type query, not a normal re-export) -- observed to build cleanly in some
 * environments and fail `tsc` in others for the exact same source. Declaring
 * it here too removes that dependency: the app's own OG route
 * (`app/[lang]/og/[...slug]/route.tsx`, from the vanilla geistdocs 1.15.2
 * template) always type-checks regardless of that resolution quirk.
 */
import "react";

declare module "react" {
  interface HTMLAttributes<T> {
    tw?: string;
  }
}
