# Deployment & Auth (ITLK-13)

Interlock is built to run on one cheap self-hosted box, behind a login, deployable from a
fresh VPS in under an hour. This is that runbook.

## What you get

- **Auth** — a single trusted user. There is no user table and no roles (multi-user is
  deliberately deferred; the `SessionData.user` field is the seam for it). The password is
  stored as a scrypt hash — the plaintext never lives in `.env` — and a signed, sealed cookie
  carries the session. Because the cookie is self-contained, a web/worker restart doesn't drop
  your login, and there's nothing to migrate.
- **Deployment** — `docker-compose.prod.yml`: web, worker, and Postgres, with restart
  policies, healthchecks, and a persisted database volume.

## The security boundary

Two layers, one of which is real:

- **`server/middleware/auth.ts`** 401s every `/api/**` request without a valid session — the
  actual boundary, applied in one place so a new endpoint is protected by default. The
  allowlist is exactly `/api/health` (for probes) and `/api/auth/*` (to be able to log in).
- **`middleware/auth.global.ts`** is the UX half: it redirects an unauthenticated browser to
  `/login` instead of rendering a screen whose data calls would only 401.

## Fresh-VPS runbook

Assumes a Linux box with [Docker Engine + the Compose plugin](https://docs.docker.com/engine/install/)
installed, and a user in the `docker` group.

### 1. Get the code

```sh
git clone https://github.com/Einlanzerous/interlock.git
cd interlock
cp .env.example .env
```

### 2. Fill in `.env`

Everything is optional except the two auth secrets. At minimum, set these:

**`SESSION_PASSWORD`** — seals the session cookie, must be ≥32 chars:

```sh
openssl rand -base64 48
```

**`AUTH_PASSWORD_HASH`** — your login password, hashed. If the box has Bun, run
`bun run auth:hash` and paste the line it prints. Otherwise generate it in a throwaway
container (you already have Docker), which mounts the repo and runs the same script:

```sh
docker run --rm -it -v "$PWD":/app -w /app oven/bun:1.3.14 bun scripts/hash-password.ts
```

It prompts for the password (so it never enters your shell history) and prints the
`AUTH_PASSWORD_HASH=…` line to paste into `.env`.

Then consider:

- **`AUTH_COOKIE_SECURE`** — set to `true` once you're serving over HTTPS (see TLS below).
  Leave `false` for the very first boot over plain HTTP, or the cookie won't be sent back and
  login will appear to loop.
- **`POSTGRES_PASSWORD`** — change it from the default before the box is reachable by anyone
  else. It sets both the database password and the internal `DATABASE_URL`.
- **`LEGISCAN_API_KEY`**, **`SMTP_URL` / `ALERT_EMAIL_TO`** — optional. Without the key,
  Illinois GA ingest is simply off (loudly, in the worker log); Chicago's eLMS needs no key.
  Without SMTP, alerts are in-app only.

`DATABASE_URL` in `.env` is the *dev* value and is ignored by the prod stack — Compose points
web and worker at the internal `db` service itself.

### 3. Bring it up

```sh
docker compose -f docker-compose.prod.yml up -d --build
```

First boot builds both images (a few minutes), starts Postgres, and the worker migrates the
schema on connect. Add `--profile ai` if you want the optional local LLM (ITLK-14).

### 4. Verify

```sh
docker compose -f docker-compose.prod.yml ps          # all services Up/healthy
curl -s localhost:3000/api/health                     # {"ok":true,"db":"up",...}
docker compose -f docker-compose.prod.yml logs -f worker   # "scheduling N fetcher(s)…"
```

Then open `http://<box>:3000/` in a browser — you should be redirected to `/login`, and your
password should let you in.

## Reverse proxy & TLS

Publish the app on 443 with a proxy that terminates TLS and forwards to `localhost:3000`.
[Caddy](https://caddyserver.com/) does it (and gets a certificate) in two lines —
`/etc/caddy/Caddyfile`:

```
interlock.example.com {
    reverse_proxy localhost:3000
}
```

Once HTTPS is live, set `AUTH_COOKIE_SECURE=true` in `.env` and
`docker compose -f docker-compose.prod.yml up -d web` to apply it. You may also want to bind
the published port to localhost only (`WEB_PORT` → `127.0.0.1:3000` via the proxy) so the app
is reachable *only* through the proxy.

## Backups

The data lives in the `pgdata` volume. A nightly `pg_dump` to a gzipped file, via cron on the
host (`crontab -e`):

```cron
0 3 * * * cd /opt/interlock && docker compose -f docker-compose.prod.yml exec -T db pg_dump -U interlock interlock | gzip > /var/backups/interlock-$(date +\%F).sql.gz
```

Restore into a running stack with:

```sh
gunzip -c /var/backups/interlock-YYYY-MM-DD.sql.gz \
  | docker compose -f docker-compose.prod.yml exec -T db psql -U interlock interlock
```

## Operating it

- **Updates:** `git pull && docker compose -f docker-compose.prod.yml up -d --build`.
- **Crash recovery:** every service is `restart: unless-stopped`. Kill the worker
  (`docker compose -f docker-compose.prod.yml kill worker`) and Compose restarts it; it
  resumes polling from the persisted `fetch_cursor` with no manual step.
- **Logs:** `docker compose -f docker-compose.prod.yml logs -f web worker`.
- **Rotating the password:** re-run the hash command, replace `AUTH_PASSWORD_HASH` in `.env`,
  and `up -d web`. Changing `SESSION_PASSWORD` instead invalidates the current session (forces
  a fresh login), which is the lever to pull if you think a cookie leaked.
```
