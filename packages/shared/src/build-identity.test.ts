import { describe, expect, it } from 'bun:test'
import { DEV_VERSION, resolveBuildIdentity } from './build-identity'

describe('resolveBuildIdentity', () => {
  it('reports a release build verbatim', () => {
    expect(
      resolveBuildIdentity({
        APP_VERSION: '1.3.0',
        GIT_SHA: 'e345c4157d7ffa31e5d3dfc3cecc36dddc10c8ae',
      }),
    ).toEqual({ version: '1.3.0', sha: 'e345c4157d7ffa31e5d3dfc3cecc36dddc10c8ae' })
  })

  it('reports dev and no sha when nothing was stamped', () => {
    expect(resolveBuildIdentity({})).toEqual({ version: DEV_VERSION, sha: null })
  })

  // The case that actually bites. An ARG declared but never passed expands to
  // an empty string, so `ENV APP_VERSION=${APP_VERSION}` sets the key to "".
  // `process.env.APP_VERSION ?? 'dev'` would return "" — `??` only catches null
  // and undefined — and the service would report an empty version.
  it('treats a blank env var as unset, not as a value', () => {
    expect(resolveBuildIdentity({ APP_VERSION: '', GIT_SHA: '' })).toEqual({
      version: DEV_VERSION,
      sha: null,
    })
  })

  it('treats a whitespace-only env var as unset', () => {
    expect(resolveBuildIdentity({ APP_VERSION: '   ', GIT_SHA: '\t' })).toEqual({
      version: DEV_VERSION,
      sha: null,
    })
  })

  it('reports a version with no sha when only the version was stamped', () => {
    expect(resolveBuildIdentity({ APP_VERSION: '1.3.0' })).toEqual({
      version: '1.3.0',
      sha: null,
    })
  })

  // Not normalised here on purpose. A "v" prefix is a bug in the BUILD — the
  // workflow passed a tag name instead of the bare semver — and silently
  // stripping it would hide that from the one place it is visible.
  it('does not sanitise the version it is given', () => {
    expect(resolveBuildIdentity({ APP_VERSION: 'v1.3.0' }).version).toBe('v1.3.0')
  })
})
