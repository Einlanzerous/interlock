# Interlock

**Signal-grade tracking for city & state legislation.**

A self-hosted CRM + legislative-tracking tool for a Strong Towns Chicago organizer. Interlock pulls Chicago City Council (the Clerk's eLMS) and the Illinois General Assembly (LegiScan) into one canonical model, tracks the officials behind the bills, and logs every letter — routing conflicting signals safely into a single junction.

## The three jobs

1. **Track legislation** — two sources, Chicago City Council and the Illinois GA. Alert when a tracked item moves.
2. **Officials CRM** — alderpersons by ward, state reps/senators by district, the mayor, plus manually-added contacts (including federal). Contact info, committees, party, notes — linked to their bills and letters.
3. **Correspondence ledger** — every letter sent/received, tied to official(s) and bill(s), with channel, status, and follow-up dates.

## The one metric

**Zero missed movements on tracked bills.** v1 works if, over a full council/GA month, the organizer never learns of a tracked bill's movement from an outside source before Interlock alerted them.

## Architecture (v1)

All-TypeScript, self-hosted on one box via Docker Compose:

- **web** — Nuxt 3 (Vue) + Nitro server API, single-user session auth
- **worker** — Node process: fetchers + normalize/match/diff/alert consumers
- **db** — Postgres 16: single source of truth, job queue (pg-boss), and search index (tsvector FTS + pg_trgm). No Redis, no managed services.
- **notify** — SMTP + in-app feed
- **ollama** — optional local Gemma for letter drafts & change summaries

The ingestion side sits behind a **language-agnostic Fetcher seam**: fetchers implement `poll(cursor) → {records[], nextCursor}`, write to a `source_record` staging table, and enqueue a `process_record` job. The contract is the Postgres schema + job JSON — so any fetcher can later be replaced by a Go binary with nothing but a DB connection string, per-source, with zero downstream change.

## Scope fence (v1)

- **In:** bill tracking, officials CRM, correspondence ledger, alerts.
- **Out (schema-ready, not built):** campaigns/tasks, volunteer coordination, US Congress/federal bill ingest.

## Getting started

```sh
bun install
docker compose up -d db     # DB_PORT in .env if 5432 is taken on your box
bun run db:migrate          # apply packages/db/migrations (idempotent)
bun run dev
```

## Releases & commit convention

Interlock ships as versioned container images. Merges to `main` are versioned by
[release-please](https://github.com/googleapis/release-please) and published to GHCR.

- **Commits use [Conventional Commits](https://www.conventionalcommits.org)** — prefix the
  subject with `feat:`, `fix:`, `perf:`, `refactor:`, `chore:`, `docs:`, etc. Keep the ITLK
  key in the scope: `feat(ITLK-16): release pipeline`. `feat` bumps the minor, `fix`/`perf`
  the patch, and a `!` (e.g. `feat!:`) or a `BREAKING CHANGE:` footer bumps the major.
  Non-conventional commits are simply excluded from the changelog — they don't break the
  pipeline.
- **What a merge does:** a `feat:`/`fix:` merge opens (or updates) a *release PR* that bumps
  the version in `.release-please-manifest.json` and adds a `CHANGELOG.md` entry. Merging that
  PR (manually — auto-merge is blocked by policy) cuts a git tag + GitHub Release, which then
  builds and pushes `ghcr.io/einlanzerous/interlock/{web,worker}` at that semver (plus
  `{major}.{minor}` and `latest`) and notifies the `construct-server` stack to roll forward.
- **Config:** `release-please-config.json` (release-type `simple`, one root release train) and
  `.release-please-manifest.json` (the current version). Pipeline lives in
  `.github/workflows/release.yml`; CI (lint/typecheck/test) is `ci.yml`.

The release workflow needs the shared release-bot GitHub App installed on this repo
(`RELEASE_BOT_APP_ID` + `RELEASE_BOT_PRIVATE_KEY` secrets), the same App switchyard uses.

## Status

In build. The v1 epic is tracked as the **ITLK** project in switchyard: scaffold (ITLK-2) and the canonical schema + migrations (ITLK-3) are in; the Fetcher seam and ingest are next.

Design brief: [Interlock Design Brief (Claude Design)](https://claude.ai/design/p/b94ff038-929d-425c-ac73-6562bb5292b0?file=Interlock+Design+Brief.dc.html)
