<script setup lang="ts">
import { SIGNAL_LABEL, signalColor, type Signal } from '@interlock/shared'

/**
 * The signal dot — the brief's default status affordance on any row that has a status.
 *
 * Deliberately a dot and not a badge: the brief reserves filled colour blocks for the
 * letters ledger's status badge, and uses a dot everywhere a bill's signal appears (bills
 * list, an official's sponsored-bills tab, the alert feed). Sizes are the brief's: 7px in
 * a dense list, 8px in a feed row, 9px in the legend.
 *
 * Colour alone is never the whole message — the title carries the label, so the state is
 * still reachable when the colour isn't.
 */
const props = withDefaults(defineProps<{ signal: Signal; size?: number }>(), { size: 7 })
</script>

<template>
  <span
    class="dot"
    :style="{
      width: `${props.size}px`,
      height: `${props.size}px`,
      background: signalColor(props.signal),
    }"
    :title="SIGNAL_LABEL[props.signal]"
  />
</template>

<style scoped>
.dot {
  display: inline-block;
  border-radius: 50%;
  flex: none;
}
</style>
