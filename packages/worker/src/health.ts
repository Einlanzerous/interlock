import { resolveBuildIdentity } from '@interlock/shared'

/**
 * The worker's health listener (ITLK-32).
 *
 * ── Why a queue worker grew an HTTP port ───────────────────────────────────
 *
 * A worker has no HTTP surface by nature, so the cheap classification was tier
 * B: ship image labels and let a container-inspect collector read them. That
 * was rejected, and construct-server's own invariants say why:
 *
 *   "A service with NO healthcheck is the worse case, since it cannot even be
 *    seen to fail — that is how interlock-worker stayed invisibly dead."
 *
 * This worker is the estate's worked example of the failure a healthcheck
 * exists to catch. It has already been dead with nobody noticing. Tier B would
 * have given the delivery ledger a version and left that untouched; a listener
 * serving exactly one route fixes both — a Docker HEALTHCHECK now has something
 * to probe, and the ledger gets a self-reported identity with no dependency on
 * SWY-194.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 *
 * It does not query Postgres. Liveness and readiness answer different
 * questions, and a liveness probe that fails on a degraded dependency gets the
 * container killed and restarted at exactly the moment somebody wants to look
 * at it — which for a queue worker also means abandoning in-flight jobs. It
 * reports whether the worker's own boot sequence completed, which is precisely
 * the "invisibly dead" state: a process that is up but never finished starting.
 *
 * Verify a healthcheck can actually FAIL before trusting it. This one can: it
 * answers 503 until `markReady()` is called, so a worker wedged during migrate
 * or pg-boss start is visibly unhealthy rather than silently up.
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
