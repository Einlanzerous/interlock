<script setup lang="ts">
import { ref } from 'vue'

/**
 * The tier-3 review queue (ITLK-7).
 *
 * Every row here is a sponsorship the matcher **refused to guess at** — no source person
 * id, and no single name close enough (or two equally close, which is worse). One click
 * resolves it, and the click is worth making: confirming backfills the source's person id
 * onto the Official, so the same sponsor auto-links at tier 1 from the next poll onward
 * and never comes back here.
 *
 * This screen is deliberately plain. ITLK-9 owns the Officials CRM and will re-home it;
 * the route (/officials/review) is already where it belongs.
 */

interface Candidate {
  officialId: string
  fullName: string
  role: string
  ward: number | null
  district: string | null
  score: number
  districtAgrees: boolean | null
}
interface ReviewItem {
  sponsorshipId: string
  sponsorName: string
  sponsorType: string
  sourceDistrict: string | null
  sourcePersonId: string | null
  confidence: number | null
  bill: { id: string; identifier: string; title: string; source: string; jurisdiction: string }
  candidates: Candidate[]
}

const { data, refresh, pending } = await useFetch<{
  items: ReviewItem[]
  total: number
  threshold: number
}>('/api/review-queue')

const busy = ref<string | null>(null)
const error = ref<string | null>(null)

/** Rows the reviewer has opened the "new official" form on. */
const creating = ref<Record<string, { fullName: string; role: string; ward: string; district: string }>>({})

const ROLES = ['alder', 'state_rep', 'state_sen', 'mayor', 'us_rep', 'us_sen', 'other']

async function confirm(item: ReviewItem, officialId: string): Promise<void> {
  busy.value = item.sponsorshipId
  error.value = null
  try {
    await $fetch(`/api/review-queue/${item.sponsorshipId}/confirm`, {
      method: 'POST',
      body: { officialId },
    })
    await refresh()
  } catch (err: unknown) {
    error.value = messageOf(err)
  } finally {
    busy.value = null
  }
}

function openCreate(item: ReviewItem): void {
  creating.value[item.sponsorshipId] = {
    // Seed from what the source told us, so the common case is one click and Enter.
    fullName: item.sponsorName,
    role: item.bill.jurisdiction === 'chicago_council' ? 'alder' : 'state_rep',
    ward: item.sourceDistrict && /^\d+$/.test(item.sourceDistrict) ? item.sourceDistrict : '',
    district: item.sourceDistrict && !/^\d+$/.test(item.sourceDistrict) ? item.sourceDistrict : '',
  }
}

async function createAndConfirm(item: ReviewItem): Promise<void> {
  const draft = creating.value[item.sponsorshipId]
  if (!draft) return
  busy.value = item.sponsorshipId
  error.value = null
  try {
    await $fetch(`/api/review-queue/${item.sponsorshipId}/confirm`, {
      method: 'POST',
      body: {
        newOfficial: {
          fullName: draft.fullName,
          role: draft.role,
          ward: draft.ward ? Number(draft.ward) : null,
          district: draft.district || null,
        },
      },
    })
    delete creating.value[item.sponsorshipId]
    await refresh()
  } catch (err: unknown) {
    error.value = messageOf(err)
  } finally {
    busy.value = null
  }
}

function messageOf(err: unknown): string {
  const data = (err as { data?: { statusMessage?: string } })?.data
  return data?.statusMessage ?? (err instanceof Error ? err.message : String(err))
}

const pct = (n: number): string => `${Math.round(n * 100)}%`

/** Why this row is here, in the reviewer's words rather than the matcher's. */
function seat(c: Candidate): string {
  if (c.ward != null) return `Ward ${c.ward}`
  if (c.district) return c.district
  return '—'
}
</script>

<template>
  <main>
    <h1>Review queue</h1>
    <p class="muted intro">
      Sponsors the matcher would not guess at. It auto-links on an exact source id, or on a
      name scoring <strong>{{ pct(data?.threshold ?? 0.85) }}</strong> or better with an
      agreeing ward/district — everything else lands here rather than being guessed.
      Confirming one teaches it the person’s source id, so they auto-link from the next poll on.
    </p>

    <p v-if="error" class="error">{{ error }}</p>

    <p v-if="!data?.items.length" class="card muted">
      Nothing awaiting review. Every sponsor resolved to an official.
    </p>

    <section v-for="item in data?.items ?? []" :key="item.sponsorshipId" class="card row">
      <header class="row-head">
        <div>
          <span class="sponsor">{{ item.sponsorName }}</span>
          <span v-if="item.sourceDistrict" class="chip">{{ item.sourceDistrict }}</span>
          <span class="chip type">{{ item.sponsorType }}</span>
        </div>
        <div class="bill muted">
          {{ item.bill.identifier }} — {{ item.bill.title }}
        </div>
      </header>

      <p class="why muted">
        <template v-if="!item.candidates.length">
          No official in the CRM resembles this name.
        </template>
        <template v-else-if="item.confidence !== null">
          Best name match scored {{ pct(item.confidence) }} — under the
          {{ pct(data?.threshold ?? 0.85) }} bar, or more than one official tied for it.
        </template>
      </p>

      <table v-if="item.candidates.length" class="candidates">
        <thead>
          <tr><th>Official</th><th>Role</th><th>Seat</th><th>Name match</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="c in item.candidates" :key="c.officialId">
            <td>{{ c.fullName }}</td>
            <td class="muted">{{ c.role }}</td>
            <td :class="{ conflict: c.districtAgrees === false }">
              {{ seat(c) }}
              <span v-if="c.districtAgrees === false" title="The source put this sponsor in a different seat">✗</span>
              <span v-else-if="c.districtAgrees === true" class="agree">✓</span>
            </td>
            <td>{{ pct(c.score) }}</td>
            <td>
              <button
                :disabled="busy === item.sponsorshipId"
                @click="confirm(item, c.officialId)"
              >
                This one
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <div v-if="creating[item.sponsorshipId]" class="create">
        <input v-model="creating[item.sponsorshipId]!.fullName" placeholder="Full name" />
        <select v-model="creating[item.sponsorshipId]!.role">
          <option v-for="role in ROLES" :key="role" :value="role">{{ role }}</option>
        </select>
        <input v-model="creating[item.sponsorshipId]!.ward" placeholder="Ward" size="4" />
        <input v-model="creating[item.sponsorshipId]!.district" placeholder="District" size="8" />
        <button class="primary" :disabled="busy === item.sponsorshipId" @click="createAndConfirm(item)">
          Create &amp; link
        </button>
        <button :disabled="busy === item.sponsorshipId" @click="delete creating[item.sponsorshipId]">
          Cancel
        </button>
      </div>
      <div v-else class="actions">
        <button :disabled="busy === item.sponsorshipId" @click="openCreate(item)">
          None of these — add this person
        </button>
      </div>
    </section>

    <p v-if="data && data.total > data.items.length" class="muted">
      Showing {{ data.items.length }} of {{ data.total }}.
    </p>
    <p v-if="pending" class="muted">Refreshing…</p>
  </main>
</template>

<style scoped>
h1 { margin: 24px 0 8px; }
.intro { max-width: 70ch; }
.error {
  background: #2a1614;
  border: 1px solid var(--bad);
  color: var(--bad);
  border-radius: 8px;
  padding: 10px 14px;
}
.row-head { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.sponsor { font-weight: 600; font-size: 1.05rem; }
.chip {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: 0.78rem;
  color: var(--muted);
}
.chip.type { text-transform: lowercase; }
.bill { font-size: 0.88rem; max-width: 48ch; text-align: right; }
.why { font-size: 0.88rem; margin: 10px 0 0; }
.candidates { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.92rem; }
.candidates th {
  text-align: left;
  font-weight: 500;
  color: var(--muted);
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--line);
}
.candidates td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--line); }
.candidates tr:last-child td { border-bottom: none; }
.conflict { color: var(--bad); }
.agree { color: var(--ok); }
.actions, .create { margin-top: 14px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
</style>
