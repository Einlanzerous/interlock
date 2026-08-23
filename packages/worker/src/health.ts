import { resolveBuildIdentity } from '@interlock/shared'

/**
 * The worker's health listener (ITLK-32).
 *
 * ── Why a queue worker grew an HTTP port ───────────────────────────────────
 *
 * A worker has no HTTP surface by nature, so the cheap classification was tier
 * B: ship image labels and let SWY-194's container-inspect collector read them.
 * Tier A was chosen instead because it is self-reporting — the worker states
 * its own identity, with no dependency on a collector the epic records as
 * needing re-planning, and no second producer that could disagree with the
 * first about what is running.
 *
 * ── This is NOT the production healthcheck, and must not become it ─────────
 *
 * construct-server's compose already probes this worker, and with a better
 * check than anything here could be (SERV-102): it reads pgboss.version's
 * timestamp, which only the worker itself updates. The outage that motivated it
 * was the worker's connection pool wedged on a dead postgres IP while the
 * database was perfectly fine — and a probe like this one would have reported
 * healthy throughout, because this listener has no dependency on that pool.
 *
 * So this endpoint's job is the delivery ledger, not liveness. It deliberately
 * does not query Postgres: liveness and readiness answer different questions,
 * and a probe that fails on a degraded dependency gets the container killed at
 * exactly the moment somebody wants to look at it — which for a queue worker
 * also means abandoning in-flight jobs.
 *
 * What it does report is whether the worker's own boot sequence completed. It
 * answers 503 until `markReady()` is called, so a worker wedged during migrate
 * or pg-boss start is visibly unhealthy rather than silently up — and it can
 * therefore genuinely FAIL, which is the bar CLAUDE.md sets for any healthcheck
 * worth having.
 */

export interface WorkerHealthServer {
  /** Flip to ready once boot has completed. Until then /healthz answers 503. */
  markReady(): void
  stop(): Promise<void>
}

interface HealthBody {
  status: 'ok' | 'starting'
  service: 'interlock-worker'
  /** Bare semver or the literal `dev`. Never a `v` prefix. */
  version: string
  /** Full 40-char commit, or null. Never abbreviated. */
  sha: string | null
}

/**
 * Start the listener. Returns a handle whose `markReady` the caller invokes
 * once the worker has finished booting.
 *
 * The port defaults to 3001 — the web app is 3000 and the two share no image,
 * but they do share a developer running both locally.
 */
export function startHealthServer(
  port = Number(process.env.WORKER_HEALTH_PORT ?? 3001),
): WorkerHealthServer {
  const build = resolveBuildIdentity()
  let ready = false

  const server = Bun.serve({
    port,
    fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname !== '/healthz') {
        return new Response('not found', { status: 404 })
      }

      const body: HealthBody = {
        status: ready ? 'ok' : 'starting',
        service: 'interlock-worker',
        // Reported on BOTH branches. A worker still starting up is still
        // running a version, and the contract wants the identity readable from
        // the 503 path for exactly that reason.
        ...build,
      }
      return Response.json(body, { status: ready ? 200 : 503 })
    },
  })

  console.log(`[worker] health listener on :${server.port} (version=${build.version})`)

  return {
    markReady() {
      ready = true
    },
    async stop() {
      await server.stop(true)
    },
  }
}
