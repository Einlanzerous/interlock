<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * The app's confirmation dialog, replacing `window.confirm`.
 *
 * `confirm()` is not a design decision, it is the absence of one: it renders in browser
 * chrome, ignores the palette and the type system entirely, and says "localhost:3999 says…"
 * above your copy. For a destructive action — the one place the user most needs to read
 * carefully and trust what they're reading — that's the worst surface in the app.
 *
 * What `confirm()` *does* get right, and what a hand-rolled modal usually forgets, is the
 * behaviour: it traps you, Escape cancels, and the safe choice is the one already under your
 * finger. All three are reproduced here.
 *
 *   - **Escape cancels** (and, because the listener is on `window`, it works before anyone
 *     has clicked anything).
 *   - **Focus lands on Cancel**, not on the destructive button — so Enter, and a stray
 *     Space, do the harmless thing.
 *   - **Clicking the scrim cancels**, which is the modern expectation for "I didn't mean it".
 *
 * `busy` exists because deleting is a round trip: the buttons have to stay disabled while
 * it's in flight, or a double-click sends the delete twice.
 */

const props = withDefaults(
  defineProps<{
    title: string
    /** The specific thing being acted on — quoted back, so there's no doubt which row. */
    subject?: string
    body?: string
    confirmLabel?: string
    cancelLabel?: string
    /** Paints the confirm button as a hazard. Destructive by default — that's why you're here. */
    destructive?: boolean
    busy?: boolean
  }>(),
  {
    subject: '',
    body: '',
    confirmLabel: 'Confirm',
    cancelLabel: 'Cancel',
    destructive: true,
    busy: false,
  },
)

const emit = defineEmits<{ confirm: []; cancel: [] }>()

const cancelButton = ref<HTMLButtonElement | null>(null)

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !props.busy) emit('cancel')
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  cancelButton.value?.focus()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="scrim" @click.self="!busy && emit('cancel')">
    <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="label" :class="{ hazard: destructive }">
        {{ destructive ? 'This cannot be undone' : 'Confirm' }}
      </div>

      <h2 id="confirm-title">{{ title }}</h2>
      <p v-if="subject" class="subject">{{ subject }}</p>
      <p v-if="body" class="body muted">{{ body }}</p>

      <div class="actions">
        <button ref="cancelButton" :disabled="busy" @click="emit('cancel')">
          {{ cancelLabel }}
        </button>
        <button
          :class="destructive ? 'destructive' : 'primary'"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? 'Working…' : confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  background: rgba(8, 10, 13, 0.66);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* Above the compose drawer, which is z-index 10 — a confirm launched from inside the
     drawer has to sit on top of it, not under it. */
  z-index: 50;
}

.dialog {
  width: min(440px, 100%);
  background: var(--panel);
  border: 1px solid var(--line);
  /* The hazard reads on the edge, the way the brief marks a rule you must not get wrong. */
  border-left: 2px solid var(--stop);
  border-radius: 12px;
  padding: 22px 26px 20px;
}

.label.hazard { color: var(--stop); }

h2 {
  margin: 10px 0 0;
  font-size: 18px;
}

/* The row itself, quoted back — so there is no doubt about which one you're about to lose. */
.subject {
  margin: 10px 0 0;
  font-size: 14px;
  color: var(--ink);
  background: var(--panel2);
  border-radius: 6px;
  padding: 8px 10px;
  overflow-wrap: anywhere;
}

.body { margin: 10px 0 0; font-size: 13px; }

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}

/* Solid, because it is the one button in the app you should hesitate over. */
button.destructive {
  background: var(--stop);
  border-color: var(--stop);
  color: var(--bg);
  font-weight: 600;
}
button.destructive:hover:not(:disabled) {
  background: #e88f81;
  border-color: #e88f81;
  color: var(--bg);
}
</style>
