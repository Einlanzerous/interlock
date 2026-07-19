<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  OFFICIAL_ROLES,
  ORG_TYPES,
  type ContactType,
  type OfficialRole,
  type OrgType,
  type Signal,
} from '@interlock/shared'

/**
 * The Officials CRM (ITLK-9, brief §6 / user flow C).
 *
 * Two panes, one route. The roster is the left pane and the person is the right, and the
 * selected person is in the *path* (`/officials/:id`) rather than in component state — a
 * bill's sponsor list (ITLK-11) links straight at a person, and a link needs somewhere to
 * land. `[[id]]` is the optional-param form, so `/officials` renders the same screen with
 * an empty right pane.
 *
 * The detail is one fetch, not three: the whole point of the CRM is that how to reach
 * someone, what they've sponsored, and what we've said to them stop being three places.
 *
 * ── Who may edit what ──────────────────────────────────────────────────────────────
 * A sourced official is co-owned with ingest, which rewrites its contact fields on every
 * poll; only `relationship_notes`, `party` and `district` are the organizer's (no ingest
 * statement writes those three). A manual contact — the federal case — has no ingest, so
 * all of it is editable. The API enforces this; the form simply doesn't offer the edit
 * that would be reverted, and says why.
 */

interface OfficialSummary {
  id: string
  fullName: string
  contactType: ContactType
  role: OfficialRole | null
  orgType: OrgType | null
  party: string | null
  ward: number | null
  district: string | null
  email: string | null
  phone: string | null
  active: boolean
  manual: boolean
}

interface SponsoredBill {
  billId: string
  identifier: string
  title: string
  signal: Signal
  jurisdiction: string
  sponsorType: string
  lastActionDate: string | null
  position: string | null
}

interface Correspondence {
  id: string
  subject: string
  direction: string
  channel: string
  status: string
  /** Plural: one person can be both recipient and cc on the same letter. */
  roles: string[]
  sentDate: string | null
  receivedDate: string | null
  followupDate: string | null
  followupDone: boolean
}

interface Staffer {
  id: string
  fullName: string
  role: OfficialRole | null
  active: boolean
}

interface OfficialDetail extends OfficialSummary {
  department: string | null
  orgId: string | null
  orgName: string | null
  webFormUrl: string | null
  officeAddress: string | null
  relationshipNotes: string | null
  committees: Array<{ id: string; name: string; classification: string | null; role: string | null }>
  sponsoredBills: SponsoredBill[]
  letters: Correspondence[]
  staff: Staffer[]
}

const route = useRoute()
const selectedId = computed(() => (route.params.id as string | undefined) || null)

/* ── The roster (left pane) ─────────────────────────────────────────────── */

const filters = reactive({ q: '', type: '', role: '', ward: '', district: '', active: 'true' })

const { data: roster, refresh: refreshRoster } = await useFetch<OfficialSummary[]>(
  '/api/officials',
  {
    query: computed(() => ({
      q: filters.q || undefined,
      type: filters.type || undefined,
      role: filters.role || undefined,
      ward: filters.ward || undefined,
      district: filters.district || undefined,
      active: filters.active,
    })),
  },
)

// Every organization, for the "affiliated org" picker on a person. Cheap (the org list is
// short) and kept apart from the roster so the roster's own filters don't shrink it.
const { data: orgs, refresh: refreshOrgs } = await useFetch<OfficialSummary[]>('/api/officials', {
  query: { type: 'org', active: 'all' },
})

/* ── The person (right pane) ────────────────────────────────────────────── */

/**
 * The key varies with the id, and that is the whole trick.
 *
 * `useAsyncData` caches by key. With a constant key, selecting someone from the roster
 * remounts this page on the new route, Nuxt finds data already sitting under that key — the
 * "nobody is selected" entry — decides the fetch has already happened, and never calls the
 * handler. No request goes out at all, and every branch of the template is false, so the
 * pane renders *empty*. The `watch` doesn't save you: the watcher is newly created on the
 * remount, so the id it starts life with never counts as a change.
 *
 * A per-id key makes each person their own cache entry, so a new id is a real fetch.
 *
 * Vicious to catch, because a *direct load* of /officials/:id works perfectly — the server
 * had an id from the first moment. Only clicking a row is broken, which is the one way
 * anyone actually uses a two-pane screen.
 *
 * The wrapper object (rather than a bare `null`) is a smaller point: useAsyncData warns that
 * a null return "must return a value", and a warning that fires on every visit trains you to
 * ignore warnings.
 */
const {
  data: fetched,
  refresh: refreshDetail,
  pending: detailPending,
} = await useAsyncData(
  () => `official-${selectedId.value ?? 'none'}`,
  async (): Promise<{ official: OfficialDetail | null }> => {
    const id = selectedId.value
    if (!id) return { official: null }
    return { official: await $fetch<OfficialDetail>(`/api/officials/${id}`) }
  },
  { watch: [selectedId] },
)

const detail = computed(() => fetched.value?.official ?? null)

/** Orgs show Staff where people show Sponsored bills; both show Correspondence. */
const tab = ref<'bills' | 'staff' | 'letters'>('bills')
watch(selectedId, () => {
  tab.value = 'bills'
  editing.value = false
  creating.value = false
})
// When an org loads (or a person after an org), land on the tab that actually exists.
watch(
  () => detail.value?.contactType,
  (type) => {
    if (type === 'org' && tab.value === 'bills') tab.value = 'staff'
    if (type === 'person' && tab.value === 'staff') tab.value = 'bills'
  },
)

/* ── Editing and adding ─────────────────────────────────────────────────── */

type Draft = {
  contactType: ContactType
  fullName: string
  role: string
  orgType: string
  department: string
  orgId: string
  party: string
  ward: string
  district: string
  email: string
  phone: string
  webFormUrl: string
  officeAddress: string
  relationshipNotes: string
  active: boolean
}

const blank = (): Draft => ({
  contactType: 'person',
  fullName: '',
  role: 'us_sen',
  orgType: 'agency',
  department: '',
  orgId: '',
  party: '',
  ward: '',
  district: '',
  email: '',
  phone: '',
  webFormUrl: '',
  officeAddress: '',
  relationshipNotes: '',
  active: true,
})

const editing = ref(false)
const creating = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const draft = ref<Draft>(blank())

function startCreate(): void {
  draft.value = blank()
  creating.value = true
  editing.value = false
  error.value = null
}

function startEdit(o: OfficialDetail): void {
  draft.value = {
    contactType: o.contactType,
    fullName: o.fullName,
    role: o.role ?? 'us_sen',
    orgType: o.orgType ?? 'agency',
    department: o.department ?? '',
    orgId: o.orgId ?? '',
    party: o.party ?? '',
    ward: o.ward != null ? String(o.ward) : '',
    district: o.district ?? '',
    email: o.email ?? '',
    phone: o.phone ?? '',
    webFormUrl: o.webFormUrl ?? '',
    officeAddress: o.officeAddress ?? '',
    relationshipNotes: o.relationshipNotes ?? '',
    active: o.active,
  }
  editing.value = true
  creating.value = false
  error.value = null
}

/** The three columns no ingest statement writes — editable on any person. */
function humanOwned(d: Draft): Record<string, unknown> {
  return {
    relationshipNotes: d.relationshipNotes,
    party: d.party,
    district: d.district,
  }
}

/** A person's editable surface when nothing else owns the row (manual / create). */
function personFields(d: Draft): Record<string, unknown> {
  return {
    contactType: 'person',
    fullName: d.fullName,
    role: d.role,
    ward: d.ward,
    email: d.email,
    phone: d.phone,
    webFormUrl: d.webFormUrl,
    officeAddress: d.officeAddress,
    orgId: d.orgId, // '' clears the affiliation; the API turns blank into null.
    active: d.active,
    ...humanOwned(d),
  }
}

/** An org is always manual, so its whole surface is editable — no role, no seat. */
function orgFields(d: Draft): Record<string, unknown> {
  return {
    contactType: 'org',
    fullName: d.fullName,
    orgType: d.orgType,
    department: d.department,
    email: d.email,
    phone: d.phone,
    webFormUrl: d.webFormUrl,
    officeAddress: d.officeAddress,
    relationshipNotes: d.relationshipNotes,
    active: d.active,
  }
}

async function save(): Promise<void> {
  const target = detail.value
  if (!target) return
  busy.value = true
  error.value = null
  try {
    // An org is manual → whole surface. A manual person → whole surface. A sourced person →
    // only the three columns ingest never touches. contactType is immutable, so it's dropped
    // from the edit payload (the API rejects it in COLUMNS anyway).
    const body =
      target.contactType === 'org'
        ? withoutType(orgFields(draft.value))
        : target.manual
          ? withoutType(personFields(draft.value))
          : humanOwned(draft.value)
    await $fetch(`/api/officials/${target.id}`, { method: 'PATCH', body })
    editing.value = false
    await Promise.all([refreshDetail(), refreshRoster(), refreshOrgs()])
  } catch (err: unknown) {
    error.value = messageOf(err)
  } finally {
    busy.value = false
  }
}

/** contactType is a create-only field; a PATCH must not carry it. */
function withoutType(body: Record<string, unknown>): Record<string, unknown> {
  const { contactType: _drop, ...rest } = body
  return rest
}

async function create(): Promise<void> {
  busy.value = true
  error.value = null
  try {
    const body = draft.value.contactType === 'org' ? orgFields(draft.value) : personFields(draft.value)
    const created = await $fetch<{ id: string }>('/api/officials', { method: 'POST', body })
    creating.value = false
    await Promise.all([refreshRoster(), refreshOrgs()])
    await navigateTo(`/officials/${created.id}`)
  } catch (err: unknown) {
    error.value = messageOf(err)
  } finally {
    busy.value = false
  }
}

function messageOf(err: unknown): string {
  const data = (err as { data?: { statusMessage?: string } })?.data
  return data?.statusMessage ?? (err instanceof Error ? err.message : String(err))
}

/* ── Presentation ───────────────────────────────────────────────────────── */

const ROLE_LABEL: Record<string, string> = {
  alder: 'Alder',
  state_rep: 'State rep',
  state_sen: 'State sen',
  mayor: 'Mayor',
  us_rep: 'US rep',
  us_sen: 'US sen',
  other: 'Other',
}

const ORG_TYPE_LABEL: Record<string, string> = {
  agency: 'Agency',
  media: 'Media',
  advocacy: 'Advocacy',
  community_group: 'Community group',
  other: 'Other',
}

/** The seat, as a person would say it. */
function seat(o: { ward: number | null; district: string | null }): string | null {
  if (o.ward != null) return `Ward ${o.ward}`
  return o.district || null
}

/** The one-line descriptor under a name — a person's role/seat, or an org's kind. */
function kindLabel(o: OfficialSummary): string {
  if (o.contactType === 'org') return ORG_TYPE_LABEL[o.orgType ?? 'other'] ?? 'Organization'
  return (o.role && ROLE_LABEL[o.role]) || o.role || ''
}

function day(iso: string | null): string {
  return iso ? new Date(`${iso}T00:00:00`).toLocaleDateString() : '—'
}
</script>

<template>
  <main>
    <div class="head">
      <h1>Officials</h1>
      <NuxtLink to="/officials/review" class="review-link">Review queue →</NuxtLink>
    </div>
    <p class="muted intro">
      Everyone the organizer deals with — alders, state legislators, the mayor, the federal
      contacts added by hand so letters to Congress are loggable, and the organizations
      (CMAP, CDOT, community groups) a letter can be addressed to.
    </p>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="panes">
      <!-- ── Roster ─────────────────────────────────────────────────────── -->
      <section class="roster">
        <div class="filters">
          <input v-model="filters.q" type="search" placeholder="Search the roster…" class="search" />
          <div class="filter-row">
            <select v-model="filters.type">
              <option value="">People &amp; orgs</option>
              <option value="person">People</option>
              <option value="org">Organizations</option>
            </select>
            <select v-model="filters.role" :disabled="filters.type === 'org'">
              <option value="">Any role</option>
              <option v-for="r in OFFICIAL_ROLES" :key="r" :value="r">{{ ROLE_LABEL[r] }}</option>
            </select>
            <select v-model="filters.active">
              <option value="true">Active</option>
              <option value="false">Inactive</option>
              <option value="all">All</option>
            </select>
          </div>
          <div v-if="filters.type !== 'org'" class="filter-row">
            <input v-model="filters.ward" type="text" inputmode="numeric" placeholder="Ward" class="narrow" />
            <input v-model="filters.district" type="text" placeholder="District" class="narrow" />
          </div>
          <button class="primary add" @click="startCreate">+ Add contact</button>
        </div>

        <p v-if="!roster?.length" class="empty">
          <span class="label">No one matches</span>
          <span class="muted">Loosen the filters, or add a contact by hand.</span>
        </p>

        <ul v-else class="rows">
          <li v-for="o in roster" :key="o.id">
            <NuxtLink :to="`/officials/${o.id}`" :class="{ on: o.id === selectedId }">
              <OfficialAvatar :name="o.fullName" :size="16" :square="o.contactType === 'org'" />
              <span class="who">
                <span class="name">{{ o.fullName }}</span>
                <span class="sub muted">
                  {{ kindLabel(o) }}
                  <template v-if="o.contactType === 'person' && seat(o)"> · {{ seat(o) }}</template>
                  <template v-if="o.contactType === 'person' && o.party"> · {{ o.party }}</template>
                </span>
              </span>
              <span v-if="o.contactType === 'org'" class="pill org">org</span>
              <span v-else-if="o.manual" class="pill manual">manual</span>
              <span v-if="!o.active" class="pill">inactive</span>
            </NuxtLink>
          </li>
        </ul>
      </section>

      <!-- ── The person ─────────────────────────────────────────────────── -->
      <section class="detail">
        <!-- New contact -->
        <div v-if="creating" class="pane-card">
          <div class="label">Add a contact by hand</div>

          <!-- Person or organization — the choice that decides the rest of the form. -->
          <div class="seg" role="tablist">
            <button
              :class="{ on: draft.contactType === 'person' }"
              @click="draft.contactType = 'person'"
            >Person</button>
            <button
              :class="{ on: draft.contactType === 'org' }"
              @click="draft.contactType = 'org'"
            >Organization</button>
          </div>

          <p class="muted note">
            A hand-added contact has no source, so no ingest will ever touch it — that's what
            makes a US senator, or CMAP, loggable here.
          </p>

          <!-- Person -->
          <div v-if="draft.contactType === 'person'" class="form">
            <label><span class="label">Full name</span>
              <input v-model="draft.fullName" placeholder="Tammy Duckworth" /></label>
            <label><span class="label">Role</span>
              <select v-model="draft.role">
                <option v-for="r in OFFICIAL_ROLES" :key="r" :value="r">{{ ROLE_LABEL[r] }}</option>
              </select></label>
            <label><span class="label">Party</span><input v-model="draft.party" placeholder="D" /></label>
            <label><span class="label">Ward</span><input v-model="draft.ward" inputmode="numeric" /></label>
            <label><span class="label">District</span><input v-model="draft.district" placeholder="IL" /></label>
            <label><span class="label">Email</span><input v-model="draft.email" type="email" /></label>
            <label><span class="label">Phone</span><input v-model="draft.phone" /></label>
            <label><span class="label">Web form</span><input v-model="draft.webFormUrl" placeholder="https://…" /></label>
            <label class="wide"><span class="label">Office address</span>
              <input v-model="draft.officeAddress" /></label>
            <label class="wide"><span class="label">Organization <span class="faint">(if they staff one)</span></span>
              <select v-model="draft.orgId">
                <option value="">— None —</option>
                <option v-for="og in orgs ?? []" :key="og.id" :value="og.id">{{ og.fullName }}</option>
              </select></label>
            <label class="wide"><span class="label">Notes</span>
              <textarea v-model="draft.relationshipNotes" rows="3" /></label>
          </div>

          <!-- Organization -->
          <div v-else class="form">
            <label class="wide"><span class="label">Organization name</span>
              <input v-model="draft.fullName" placeholder="Chicago Metropolitan Agency for Planning" /></label>
            <label><span class="label">Type</span>
              <select v-model="draft.orgType">
                <option v-for="t in ORG_TYPES" :key="t" :value="t">{{ ORG_TYPE_LABEL[t] }}</option>
              </select></label>
            <label><span class="label">Department <span class="faint">(optional)</span></span>
              <input v-model="draft.department" placeholder="Planning Division" /></label>
            <label><span class="label">Email</span><input v-model="draft.email" type="email" /></label>
            <label><span class="label">Phone</span><input v-model="draft.phone" /></label>
            <label class="wide"><span class="label">Web form</span>
              <input v-model="draft.webFormUrl" placeholder="https://…" /></label>
            <label class="wide"><span class="label">Address</span>
              <input v-model="draft.officeAddress" /></label>
            <label class="wide"><span class="label">Notes</span>
              <textarea v-model="draft.relationshipNotes" rows="3" /></label>
          </div>

          <div class="actions">
            <button class="primary" :disabled="busy || !draft.fullName.trim()" @click="create">
              Add {{ draft.contactType === 'org' ? 'organization' : 'contact' }}
            </button>
            <button :disabled="busy" @click="creating = false">Cancel</button>
          </div>
        </div>

        <!-- Nobody selected -->
        <div v-else-if="!selectedId" class="pane-card empty-pane">
          <span class="label">No one selected</span>
          <span class="muted">Pick someone from the roster to see their contact details,
            what they've sponsored, and everything we've sent them.</span>
        </div>

        <p v-else-if="detailPending && !detail" class="pane-card muted">Loading…</p>

        <!-- The person -->
        <div v-else-if="detail" class="pane-card">
          <header class="person">
            <OfficialAvatar :name="detail.fullName" :size="34" :square="detail.contactType === 'org'" />
            <div class="person-name">
              <h2>{{ detail.fullName }}</h2>
              <div class="sub muted">
                {{ kindLabel(detail) }}
                <template v-if="detail.contactType === 'org' && detail.department">
                  · {{ detail.department }}
                </template>
                <template v-if="detail.contactType === 'person' && seat(detail)"> · {{ seat(detail) }}</template>
                <template v-if="detail.contactType === 'person' && detail.party"> · {{ detail.party }}</template>
              </div>
              <div v-if="detail.contactType === 'person' && detail.orgId" class="sub muted affil">
                at <NuxtLink :to="`/officials/${detail.orgId}`">{{ detail.orgName }}</NuxtLink>
              </div>
            </div>
            <div class="person-tags">
              <span v-if="detail.contactType === 'org'" class="pill org">org</span>
              <span v-else-if="detail.manual" class="pill manual">manual</span>
              <span v-if="!detail.active" class="pill">inactive</span>
            </div>
          </header>

          <!-- Edit -->
          <div v-if="editing" class="form edit">
            <!-- Organization: no source, so the whole surface is the organizer's. -->
            <template v-if="detail.contactType === 'org'">
              <label class="wide"><span class="label">Organization name</span>
                <input v-model="draft.fullName" /></label>
              <label><span class="label">Type</span>
                <select v-model="draft.orgType">
                  <option v-for="t in ORG_TYPES" :key="t" :value="t">{{ ORG_TYPE_LABEL[t] }}</option>
                </select></label>
              <label><span class="label">Department</span><input v-model="draft.department" /></label>
              <label><span class="label">Email</span><input v-model="draft.email" type="email" /></label>
              <label><span class="label">Phone</span><input v-model="draft.phone" /></label>
              <label class="wide"><span class="label">Web form</span><input v-model="draft.webFormUrl" /></label>
              <label class="wide"><span class="label">Address</span><input v-model="draft.officeAddress" /></label>
              <label class="wide check">
                <input v-model="draft.active" type="checkbox" /> <span class="muted">Active</span>
              </label>
              <label class="wide"><span class="label">Notes</span>
                <textarea v-model="draft.relationshipNotes" rows="4" /></label>
            </template>

            <!-- Person -->
            <template v-else>
              <template v-if="detail.manual">
                <label><span class="label">Full name</span><input v-model="draft.fullName" /></label>
                <label><span class="label">Role</span>
                  <select v-model="draft.role">
                    <option v-for="r in OFFICIAL_ROLES" :key="r" :value="r">{{ ROLE_LABEL[r] }}</option>
                  </select></label>
                <label><span class="label">Ward</span><input v-model="draft.ward" inputmode="numeric" /></label>
                <label><span class="label">Email</span><input v-model="draft.email" type="email" /></label>
                <label><span class="label">Phone</span><input v-model="draft.phone" /></label>
                <label><span class="label">Web form</span><input v-model="draft.webFormUrl" /></label>
                <label class="wide"><span class="label">Office address</span>
                  <input v-model="draft.officeAddress" /></label>
                <label class="wide"><span class="label">Organization <span class="faint">(if they staff one)</span></span>
                  <select v-model="draft.orgId">
                    <option value="">— None —</option>
                    <option v-for="og in orgs ?? []" :key="og.id" :value="og.id">{{ og.fullName }}</option>
                  </select></label>
                <label class="wide check">
                  <input v-model="draft.active" type="checkbox" /> <span class="muted">Active</span>
                </label>
              </template>
              <p v-else class="muted note wide">
                Contact details come from the feed and are rewritten on every poll, so they
                aren't editable here — an edit would be reverted within the hour. Party,
                district and notes are yours.
              </p>
              <label><span class="label">Party</span><input v-model="draft.party" /></label>
              <label><span class="label">District</span><input v-model="draft.district" /></label>
              <label class="wide"><span class="label">Notes</span>
                <textarea v-model="draft.relationshipNotes" rows="4" /></label>
            </template>

            <div class="actions wide">
              <button class="primary" :disabled="busy" @click="save">Save</button>
              <button :disabled="busy" @click="editing = false">Cancel</button>
            </div>
          </div>

          <!-- Contact + notes -->
          <template v-else>
            <dl class="contact">
              <template v-if="detail.contactType === 'org' && detail.department">
                <dt class="label">Department</dt>
                <dd>{{ detail.department }}</dd>
              </template>
              <template v-if="detail.email">
                <dt class="label">Email</dt>
                <dd><a :href="`mailto:${detail.email}`">{{ detail.email }}</a></dd>
              </template>
              <template v-if="detail.phone">
                <dt class="label">Phone</dt>
                <dd class="mono">{{ detail.phone }}</dd>
              </template>
              <template v-if="detail.webFormUrl">
                <dt class="label">Web form</dt>
                <dd><a :href="detail.webFormUrl" target="_blank" rel="noopener">{{ detail.webFormUrl }}</a></dd>
              </template>
              <template v-if="detail.officeAddress">
                <dt class="label">Office</dt>
                <dd>{{ detail.officeAddress }}</dd>
              </template>
              <template v-if="detail.committees.length">
                <dt class="label">Committees</dt>
                <dd class="committees">
                  <span v-for="c in detail.committees" :key="c.id" class="pill">
                    {{ c.name }}<template v-if="c.role"> · {{ c.role }}</template>
                  </span>
                </dd>
              </template>
            </dl>

            <div class="notes">
              <div class="label">My notes</div>
              <p v-if="detail.relationshipNotes" class="notes-body">{{ detail.relationshipNotes }}</p>
              <p v-else class="faint notes-body">
                Nothing yet. What do we know about this {{ detail.contactType === 'org' ? 'organization' : 'person' }}?
              </p>
            </div>

            <div class="actions">
              <button @click="startEdit(detail)">Edit</button>
            </div>
          </template>

          <!-- Tabs -->
          <div class="tabs">
            <button
              v-if="detail.contactType === 'org'"
              :class="tab === 'staff' ? 'secondary' : ''"
              @click="tab = 'staff'"
            >
              Staff · {{ detail.staff.length }}
            </button>
            <button
              v-else
              :class="tab === 'bills' ? 'secondary' : ''"
              @click="tab = 'bills'"
            >
              Sponsored bills · {{ detail.sponsoredBills.length }}
            </button>
            <button :class="tab === 'letters' ? 'secondary' : ''" @click="tab = 'letters'">
              Correspondence · {{ detail.letters.length }}
            </button>
          </div>

          <!-- Sponsored bills (person) -->
          <div v-if="tab === 'bills'">
            <p v-if="!detail.sponsoredBills.length" class="faint tab-empty">
              Nothing sponsored — or nothing the matcher has linked to them yet.
            </p>
            <ul v-else class="rows bills">
              <li v-for="b in detail.sponsoredBills" :key="b.billId">
                <SignalDot :signal="b.signal" :size="7" />
                <span class="ident">{{ b.identifier }}</span>
                <span class="bill-title">{{ b.title }}</span>
                <span class="pill">{{ b.sponsorType }}</span>
                <span v-if="b.position" class="pill stance">{{ b.position }}</span>
                <span class="when faint">{{ day(b.lastActionDate) }}</span>
              </li>
            </ul>
          </div>

          <!-- Staff (org) -->
          <div v-else-if="tab === 'staff'">
            <p v-if="!detail.staff.length" class="faint tab-empty">
              No named contacts yet. Add a person and set their organization to this one.
            </p>
            <ul v-else class="rows">
              <li v-for="s in detail.staff" :key="s.id">
                <NuxtLink :to="`/officials/${s.id}`" class="staff-row">
                  <OfficialAvatar :name="s.fullName" :size="16" />
                  <span class="staff-name">{{ s.fullName }}</span>
                  <span class="sub muted">{{ s.role ? (ROLE_LABEL[s.role] ?? s.role) : '' }}</span>
                  <span v-if="!s.active" class="pill">inactive</span>
                </NuxtLink>
              </li>
            </ul>
          </div>

          <!-- Correspondence -->
          <div v-else>
            <p v-if="!detail.letters.length" class="faint tab-empty">
              Nothing sent, nothing received.
              <NuxtLink :to="`/letters?officialId=${detail.id}`">Log the first one →</NuxtLink>
            </p>
            <template v-else>
              <ul class="rows letters">
                <li v-for="l in detail.letters" :key="l.id">
                  <span class="status" :data-status="l.status">{{ l.status }}</span>
                  <span class="subject">{{ l.subject }}</span>
                  <span class="pill">{{ l.direction }}</span>
                  <span class="pill">{{ l.channel }}</span>
                  <span class="pill">{{ l.roles.join(' · ') }}</span>
                  <span class="when faint">{{ day(l.sentDate ?? l.receivedDate) }}</span>
                </li>
              </ul>
              <p class="tab-more">
                <NuxtLink :to="`/letters?officialId=${detail.id}`">Open in the ledger →</NuxtLink>
              </p>
            </template>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>

<style scoped>
.head { display: flex; align-items: baseline; justify-content: space-between; margin-top: 28px; }
h1 { margin: 0; font-size: 30px; }
.review-link { font-family: var(--font-mono); font-size: 12px; }
.intro { max-width: 66ch; margin: 8px 0 20px; }

/* Two panes: list left, person right — the person is marginally wider (brief §6).
   minmax(0, …) rather than a bare 1fr: a grid track's implicit minimum is its content,
   so one long unbreakable committee name would otherwise push the pane past the viewport
   instead of wrapping inside it. */
.panes {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
  gap: 16px;
  align-items: start;
}

/* --- Roster --------------------------------------------------------------- */
.roster {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px;
}
.filters { display: flex; flex-direction: column; gap: 8px; }
.search { width: 100%; }
.filter-row { display: flex; gap: 6px; }
.filter-row select { flex: 1; min-width: 0; }
.narrow { width: 74px; }
.add { width: 100%; }

.rows { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
/* The roster is the whole council + every manually-added contact — too long to push the page.
   Cap it to the viewport and let it scroll inside its own pane; the small right padding keeps
   the scrollbar off the rows. */
.roster .rows {
  max-height: calc(100vh - 300px);
  overflow-y: auto;
  padding-right: 4px;
}
.roster .rows a {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid transparent;
  color: var(--ink2);
}
.roster .rows a:hover { background: var(--panel2); }
.roster .rows a.on { background: var(--accdim); border-color: var(--accent); }
.who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.name { font-family: var(--font-display); font-weight: 600; color: var(--ink); font-size: 14px; line-height: 1.3; }
.sub { font-size: 12px; line-height: 1.4; }

.empty, .empty-pane {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 28px 16px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  margin-top: 12px;
  font-size: 13px;
}

/* --- The person ----------------------------------------------------------- */
.pane-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 20px 26px;
}
.empty-pane { margin-top: 0; border-style: dashed; text-align: center; align-items: center; }

.person { display: flex; align-items: center; gap: 12px; }
.person-name { flex: 1; min-width: 0; }
.person h2 { margin: 0; font-size: 20px; }
.person-tags { display: flex; gap: 6px; }

.contact {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 6px 14px;
  margin: 18px 0 0;
  font-size: 14px;
}
.contact dt { padding-top: 3px; }
.contact dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.committees { display: flex; flex-wrap: wrap; gap: 6px; }
/* Committee names are long sentences, not identifiers — let them wrap rather than
   hold the pane open. (The pill default is nowrap, which suits a ward or a party.) */
.committees .pill { white-space: normal; }

.notes { margin-top: 18px; }
.notes-body { margin: 6px 0 0; font-size: 14px; white-space: pre-wrap; }

.note { font-size: 13px; margin: 6px 0 14px; }
.actions { display: flex; gap: 8px; margin-top: 16px; }

.affil { margin-top: 2px; }
.affil a { color: var(--accent); }

/* --- Person / org segmented toggle ---------------------------------------- */
.seg { display: inline-flex; margin: 14px 0 4px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button {
  border: 0;
  border-radius: 0;
  background: var(--panel);
  color: var(--ink2);
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
}
.seg button + button { border-left: 1px solid var(--line); }
.seg button.on { background: var(--accdim); color: var(--ink); }

/* --- Staff rows (org detail) ---------------------------------------------- */
.staff-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel2);
  border-radius: 5px;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--ink2);
}
.staff-row:hover { background: var(--accdim); }
.staff-name { font-weight: 600; color: var(--ink); }
.staff-row .sub { flex: 1; min-width: 0; }

/* --- Forms ---------------------------------------------------------------- */
.form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; margin-top: 14px; }
.form.edit { margin-top: 18px; }
.form label { display: flex; flex-direction: column; gap: 4px; }
.form .wide { grid-column: 1 / -1; }
.form input, .form select, .form textarea { width: 100%; }
.form .check { flex-direction: row; align-items: center; gap: 8px; }
.form .check input { width: auto; }

/* --- Tabs ----------------------------------------------------------------- */
.tabs { display: flex; gap: 8px; margin: 22px 0 14px; border-top: 1px solid var(--linesoft); padding-top: 18px; }
.tab-empty { font-size: 13px; padding: 14px 0; }
.tab-more { font-family: var(--font-mono); font-size: 12px; margin: 10px 0 0; }

/* --- Tab rows ------------------------------------------------------------- */
.bills li, .letters li {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel2);
  border-radius: 5px;
  padding: 8px 10px;
  font-size: 13px;
}
.bill-title, .subject {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink2);
}
.ident { font-size: 12px; flex: none; }
.when { font-size: 12px; font-family: var(--font-mono); flex: none; }
.pill.stance { color: var(--caution); border-color: var(--caution); }

/* The ledger's filled status badge (brief §6) — the one place a signal colour is a fill. */
.status {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  border-radius: 4px;
  padding: 2px 6px;
  min-width: 62px;
  text-align: center;
  flex: none;
  color: var(--bg);
  background: var(--faint);
}
.status[data-status='sent'] { background: var(--caution); }
.status[data-status='responded'] { background: var(--go); }
.status[data-status='closed'] { background: var(--muted); }

@media (max-width: 900px) {
  .panes { grid-template-columns: 1fr; }
}
</style>
