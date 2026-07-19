<script setup lang="ts">
import { computed } from 'vue'

/**
 * The avatar circle that leads every roster row (brief §6, Officials wireframe).
 *
 * The brief is deliberate that officials rows lead with an avatar and bills rows lead with
 * a signal dot: at a glance, the shape of the row tells you which list you're looking at.
 *
 * There are no photos to show — eLMS and LegiScan don't ship any — so it's initials on the
 * nested-surface fill, which is what the wireframe draws.
 */
const props = withDefaults(
  defineProps<{ name: string; size?: number; square?: boolean }>(),
  { size: 16, square: false },
)

/**
 * "Lopez, Raymond A." and "Raymond Lopez" should agree, so the comma form is flipped
 * before initials are taken — otherwise the roster shows LR for one and RL for the other.
 *
 * A single-word name — an org acronym like "CMAP", or a mononym — takes its first two
 * letters rather than one, so the glyph never collapses to a lone character.
 */
const initials = computed(() => {
  const raw = props.name.trim()
  const name = raw.includes(',')
    ? `${raw.slice(raw.indexOf(',') + 1).trim()} ${raw.slice(0, raw.indexOf(','))}`
    : raw
  const words = name.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w))
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase()
  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase()
})
</script>

<template>
  <span
    class="avatar"
    :class="{ square: props.square }"
    :style="{
      width: `${props.size}px`,
      height: `${props.size}px`,
      fontSize: `${Math.round(props.size * 0.4)}px`,
    }"
    aria-hidden="true"
  >{{ initials }}</span>
</template>

<style scoped>
.avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--panel2);
  border: 1px solid var(--line);
  color: var(--muted);
  font-family: var(--font-mono);
  letter-spacing: 0.02em;
  flex: none;
  user-select: none;
}
/* An organization reads as a rounded square, so the roster's shape tells person from org
   before the label does — the same "shape signals the kind" logic as the signal dot. */
.avatar.square { border-radius: 28%; }
</style>
