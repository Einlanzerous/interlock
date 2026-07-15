import { useAuthSession } from '../../utils/auth'

/** Clear the session cookie. Safe to call without one — always ends unauthenticated. */
export default defineEventHandler(async (event) => {
  const session = await useAuthSession(event)
  await session.clear()
  return { authenticated: false }
})
