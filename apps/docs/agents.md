# Geistdocs agent instructions

This project uses the packaged Geistdocs architecture. The `@vercel/geistdocs` package owns shared runtime behavior; this app owns local content, configuration, adapters, and site-specific routes.

Use these instructions when an AI coding agent edits this project.

## Architecture

- Runtime features come from `@vercel/geistdocs`, including the docs page renderer, layout helpers, MDX components, search, Ask AI, markdown routes, proxy helpers, and source helpers.
- `@vercel/geistdocs` owns the Ask AI client, server route behavior, and AI SDK v6 runtime dependencies. Do not fork package internals to fit an older app-level `ai` version.
- Local files are user-owned adapters. They should stay thin and call public package exports from `@vercel/geistdocs/*`.
- Do not copy package internals into the app to make a customization. Prefer configuring an adapter file or upgrading `@vercel/geistdocs`.
- Do not deep import from `@vercel/geistdocs/dist` or edit files in `node_modules/@vercel/geistdocs`.
- Do not edit generated directories such as `.source/`, `.next/`, `node_modules/`, or build output.

## Package Docs For Agents

- When package API behavior is unclear, read the installed package docs in `node_modules/@vercel/geistdocs/docs` before guessing.
- Start with `node_modules/@vercel/geistdocs/docs/agents.md` and `node_modules/@vercel/geistdocs/docs/sitemap.md` to identify the relevant focused page.
- Use `node_modules/@vercel/geistdocs/docs/pages/*.md` for task-specific guidance and `node_modules/@vercel/geistdocs/docs/llms.txt` only when you need broad package context.
- These package docs are read-only generated artifacts. Do not edit files under `node_modules/@vercel/geistdocs`; change local adapter files or update the package instead.

## Common edit targets

| Task | Edit |
| --- | --- |
| Configure site title, logo, nav, GitHub links, AI prompt, suggestions, translations, `basePath`, or `siteId` | `geistdocs.tsx` |
| Edit public agent best-fit use cases or operational instructions shared by `/agents.md` and `/llms.txt` | `lib/agent-guidance.ts` |
| Add or update documentation pages | `content/docs/**/*.mdx` |
| Control sidebar order, groups, and labels | `content/docs/meta.json` |
| Override MDX components | `components/geistdocs/mdx-components.tsx` |
| Wrap the site provider, analytics, or global client behavior | `components/geistdocs/provider.tsx` |
| Customize the docs layout shell | `components/geistdocs/docs-layout.tsx` |
| Configure the Fumadocs source adapter or versioned docs | `lib/geistdocs/source.ts` |
| Configure Fumadocs collections and source-safe MDX processing | `source.config.ts` |
| Configure the docs page renderer | `app/[lang]/docs/[[...slug]]/page.tsx` |
| Configure AI-readable markdown output | `app/[lang]/agents.md/route.ts`, `app/[lang]/.well-known/mcp.json/route.ts`, `app/[lang]/llms.txt/route.ts`, `app/[lang]/llms-full.txt/route.ts`, `app/[lang]/llms.mdx/[[...slug]]/route.ts`, `app/[lang]/sitemap.md/route.ts` |
| Configure chat or search APIs | `app/api/chat/route.ts`, `app/api/search/route.ts` |
| Configure the structured JSON fallback for unknown `/api/*` paths | `lib/api-not-found.ts`, `app/api/[...notFound]/route.ts` |
| Add request handling before or after Geistdocs routing | `proxy.ts` |
| Edit the marketing home page | `app/[lang]/(home)/**` |
| Edit shared styles | `app/global.css`, `app/styles/geistdocs.css` |

## Content guidelines

- Put docs in `content/docs` unless the project has added another source in `lib/geistdocs/source.ts`.
- Add each new page to `content/docs/meta.json` so it appears in the sidebar.
- Use MDX frontmatter with at least `title` and `description` for documentation pages.
- Keep slugs stable unless the task explicitly includes redirects or link updates.
- When adding translated content, follow the existing locale suffix pattern, such as `page.cn.mdx`.
- Use `CopyPrompt` when a page should give readers a prompt they can copy into a coding agent.

## Routing and proxy guidelines

- Keep App Router route files as thin adapters around package helpers such as `createDocsPage`, `createChatRoute`, `createLlmsRoute`, and `createProxy`.
- Keep `export const config` in `proxy.ts` as a static object. Next.js must parse proxy matchers at build time.
- Use proxy matcher exclusions that only match `/api` and `/api/...`, such as `api(?:/|$)`. Do not exclude broad prefixes like `api`, because that also excludes routes such as `/api-reference`.
- Preserve markdown negotiation unless the task explicitly changes AI-readable output. The app serves a concise `/llms.txt` index, a `createLlmsRoute`-backed `/llms-full.txt` corpus, `/agents.md`, `/.well-known/mcp.json`, and per-page Markdown for `.md`, `.mdx`, `Accept: text/markdown`, and AI-agent requests.
- Preserve the proxy `after` hook that returns a recoverable Markdown 404 for unknown agent requests outside `/docs`. When adding a valid HTML app route, add it to `lib/geistdocs/markdown-not-found.ts` so Markdown-preferring clients still receive the real page rather than the fallback.
- Preserve `app/api/[...notFound]/route.ts` as the lowest-precedence API route. Valid API routes must retain their own contracts, unknown `/api/*` paths return a stable JSON 404 instead of the framework HTML response, and the existing bare `/api` redirect continues to lead to `/docs/reference`.
- When adding custom proxy behavior, prefer `before`, `after`, and `markdownRoutes` options on `createProxy` instead of replacing the proxy.
- Use explicit `markdownRoutes` for root-mounted docs or any site where homepage/app routes coexist with docs routes.
- Keep source URLs, navigation links, `getPageUrl`, and `markdownRoutes` app-local when `config.basePath` is set. Geistdocs derives public page-action and Markdown URLs separately.
- Include `"/"` explicitly in the static proxy matcher when a Next.js base-path application serves documentation at its app root.

## Ask AI and Vertex proxy guidelines

- Leave `GEISTDOCS_CHAT_PROXY_URL` unset and `ai.eveAgent` unconfigured to use the default AI Gateway path. In that mode, `app/api/chat/route.ts` calls `createChatRoute` without a `proxy` option and uses the local docs search tool during the AI SDK `streamText` loop.
- Set `ai.eveAgent: { url }` in `geistdocs.tsx` to answer Ask AI with a hosted eve framework agent instead. The URL flows through the config object; the route file needs no changes. Requests authenticate with a per-request Vercel OIDC bearer token by default; pass server-only headers through the `eveAgent` option on `createChatRoute` for custom auth. Never put auth material in `geistdocs.tsx`. Configuring both `proxy` and an eve agent throws at route creation.
- Geistdocs Ask AI targets AI SDK v6: `ai` v6 and `@ai-sdk/react` v3. Keep those dependencies on the generated package versions unless a `@vercel/geistdocs` release changes them.
- If the app uses `ai` or `@ai-sdk/react` for product code outside Geistdocs, migrate that app code separately or let the package manager install separate versions. Do not downgrade Geistdocs Ask AI to match unrelated app code.
- Set `GEISTDOCS_CHAT_PROXY_URL` only when Ask AI should route through the central Vertex-backed proxy. The value must include the `/vertex` route, such as `https://<geistdocs-platform-deployment>/vertex`.
- Do not add Vertex credentials to a Geistdocs site. The central platform proxy forwards the Vercel OIDC token in `x-vercel-trusted-oidc-idp-token`; the Vertex deployment should trust the platform Vercel project through Deployment Protection Trusted Sources.
- Use `GEISTDOCS_CHAT_PROXY_TOKEN` only for a custom proxy that requires bearer authentication. The default Geistdocs platform `/vertex` proxy does not require it.
- Keep `app/api/chat/route.ts` as a thin adapter around `createChatRoute`. Prefer configuring `GEISTDOCS_CHAT_PROXY_URL` and `GEISTDOCS_CHAT_PROXY_TOKEN` over forking the package chat route.
- If custom chat client code uses `DefaultChatTransport.prepareSendMessagesRequest`, preserve `messages` in the returned `body` when adding fields such as `currentRoute`. Returning a custom `body` replaces the AI SDK default request body.

## Migration guidelines

- When migrating from Fumadocs or a custom Geist docs site, inventory `source.config.ts`, route files, `middleware.ts` or `proxy.ts`, `public/llms.txt`, OG routes, Tailwind CSS setup, and required environment variables before editing.
- Inventory direct app usage of `ai` and `@ai-sdk/react`. Package-owned Ask AI uses AI SDK v6; migrate local AI SDK code separately from Geistdocs route adapters.
- Import source-config helpers from `@vercel/geistdocs/source-config` in `source.config.ts`. Do not import runtime component entry points from source config.
- Move existing `middleware.ts` behavior into `createProxy({ before })` or `createProxy({ after })` hooks.
- Delete `public/llms.txt` when an App Router llms route exists; otherwise the static file can mask the concise `/llms.txt` index or a `createLlmsRoute` adapter.
- Set `openGraph.images` in `createDocsPage` only when the app includes the Geistdocs OG route, or override metadata to avoid broken `/og/...` URLs.
- Add Tailwind CSS v4 `@source` entries for `@vercel/geistdocs` and related runtime dependencies when migrating styles.
- Add local fallbacks for production-only environment variables so migration builds do not require production secrets.

## Package updates

- Use `pnpm exec geistdocs update` to update package-based Geistdocs projects.
- `geistdocs update` updates the `@vercel/geistdocs` dependency. It does not overwrite local adapter files.
- Review dependency changes and run the verification commands before committing an update.

## Commands

- Start development: `pnpm dev`
- Build for production: `pnpm build`
- Start the built app: `pnpm start`
- Regenerate Fumadocs output after dependency installation: `pnpm postinstall`
- Update Geistdocs: `pnpm exec geistdocs update`
- Run translations if configured: `pnpm translate`

## Verification

- Run `pnpm build` after changing routes, config, source setup, MDX components, or package versions.
- Run `pnpm dev` and open the changed pages when visual layout, navigation, or MDX rendering changes.
- Check both `/docs` and AI-readable routes such as `/agents.md`, `/.well-known/mcp.json`, `/llms.txt`, `/llms-full.txt`, a page-level `.md` URL, an unknown URL with `Accept: text/markdown`, and an unknown `/api` path when changing content routing or proxy behavior.
- Confirm no secrets were added to source files. Use `.env.local` for local values and keep it out of Git.
