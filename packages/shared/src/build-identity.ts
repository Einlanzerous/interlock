/**
 * Build identity — the `version` + `sha` half of the health contract (ITLK-32).
 *
 * Switchyard's delivery reconciler polls a service's health endpoint and reads
 * these two fields to record what is actually running: the observed half of the
 * estate's delivery ledger (SWY-192 defines the contract, SERV-128 owns the
 * rollout). An observation is the half that is supposed to be trustworthy — a
 * report says what someone MEANT to deploy, an observation says what answered —
 * so a process that reports a plausible version it did not ship becomes a real
 * row in that ledger, indistinguishable from a real deploy.
 *
 * Lives in `shared` because BOTH images report it: the Nuxt server from
 * `/api/health` and the worker from its own listener. One definition means the
 * two cannot drift into disagreeing about what interlock 1.3.0 means.
 *
 * ── Why the blank check is not paranoia ────────────────────────────────────
 *
 * These arrive from Docker `ARG`s promoted to `ENV`. An ARG that is declared but
 * never passed expands to an EMPTY STRING, not to an unset variable, so
 * `ENV APP_VERSION=${APP_VERSION}` sets the key to `""`. A naive
 * `process.env.APP_VERSION ?? 'dev'` therefore returns `""` — `??` only catches
 * null and undefined — and the service reports a version of empty string. Not a
 * crash: just a silently wrong answer propagated into every consumer.
 */

/** What a process reports when it was not built by a release. */
export const DEV_VERSION = 'dev'

export interface BuildIdentity {
  /**
   * Bare semver, or the literal `dev`. Never carries a `v` prefix: Switchyard
   * compares this with strict equality against the image's
   * `org.opencontainers.image.version` label, which `docker/metadata-action`
   * stamps bare. A prefix files every deploy report as `claimed_not_confirmed`,
   * permanently.
   */
  version: string
  /**
   * The full 40-character commit, or `null` when the build supplied none.
   * Reported verbatim — abbreviating here would turn the cross-service
   * comparison into a prefix problem.
   */
  sha: string | null
}

/** Trim, then treat blank and whitespace-only as absent. */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Resolve what this build honestly reports.
 *
 * Takes the environment as a parameter rather than reading `process.env`
 * directly, so the blank/unset/set cases are unit-testable without mutating
 * global state.
 */
export function resolveBuildIdentity(
  env: Record<string, string | undefined> = process.env,
): BuildIdentity {
  return {
    version: present(env.APP_VERSION) ?? DEV_VERSION,
    sha: present(env.GIT_SHA) ?? null,
  }
}
