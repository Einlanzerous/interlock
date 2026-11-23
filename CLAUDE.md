# Interlock

Nuxt 3 frontend in `apps/web`, Bun workspaces. Conventional Commits + release-please
(see `~/construct-server/PRINCIPLES.md` §3).

## Browser target

Firefox is the primary browser. Floor: Firefox 160 (the Firefox release when this was set;
the quarterly `frontend-audit` run raises it). Anything newer is progressive enhancement
behind `@supports` or feature detection. The Vite `build.target` lives in
`apps/web/nuxt.config.ts` under `vite.build.target`.
