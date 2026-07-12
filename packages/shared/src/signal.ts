/**
 * Signal legend from the design brief — the canonical status of a bill reduced
 * to a four-state traffic signal the UI colors consistently.
 *
 *   WATCH   introduced / referred
 *   CAUTION in committee
 *   CLEAR   passed / enacted
 *   STOP    failed / vetoed
 */
export const SIGNALS = ['watch', 'caution', 'clear', 'stop'] as const

export type Signal = (typeof SIGNALS)[number]

export const SIGNAL_COLOR: Record<Signal, string> = {
  watch: '#6ea8e0',
  caution: '#e0b155',
  clear: '#57c88a',
  stop: '#e07a6b',
}

export const SIGNAL_LABEL: Record<Signal, string> = {
  watch: 'Watch',
  caution: 'Caution',
  clear: 'Clear',
  stop: 'Stop',
}

export function signalColor(signal: Signal): string {
  return SIGNAL_COLOR[signal]
}
