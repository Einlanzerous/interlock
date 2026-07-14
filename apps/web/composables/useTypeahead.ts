import { ref, watch, type Ref } from 'vue'

/**
 * The typeahead behind "who is this letter to?" and "which bill is it about?" (flow B).
 *
 * Two things here are not decoration:
 *
 *   - **Debounce.** The organizer types "transit funding" in about a second; without this
 *     that is fifteen FTS queries, fourteen of them already stale by the time they land.
 *
 *   - **Sequence guard.** Responses can arrive out of order — the query for "tran" can
 *     land after the query for "transit" — and the last response to arrive would win,
 *     leaving the list showing results for a prefix of what's in the box. Stamping each
 *     request and dropping anything but the newest is the difference between a typeahead
 *     that feels wrong "sometimes" and one that doesn't.
 */
export function useTypeahead<T>(
  endpoint: string,
  extraQuery: Record<string, string> = {},
): {
  q: Ref<string>
  results: Ref<T[]>
  searching: Ref<boolean>
  clear: () => void
} {
  const q = ref('')
  const results = ref<T[]>([]) as Ref<T[]>
  const searching = ref(false)

  let latest = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  watch(q, (value) => {
    clearTimeout(timer)
    const term = value.trim()
    if (!term) {
      results.value = []
      searching.value = false
      return
    }

    searching.value = true
    timer = setTimeout(async () => {
      const seq = ++latest
      try {
        const found = await $fetch<T[]>(endpoint, {
          query: { q: term, limit: 8, ...extraQuery },
        })
        if (seq !== latest) return // a newer keystroke already answered
        results.value = found
      } catch {
        if (seq === latest) results.value = []
      } finally {
        if (seq === latest) searching.value = false
      }
    }, 180)
  })

  function clear(): void {
    clearTimeout(timer)
    latest++ // orphan any in-flight response, so it can't repopulate a cleared box
    q.value = ''
    results.value = []
    searching.value = false
  }

  return { q, results, searching, clear }
}
