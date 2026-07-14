/**
 * Signal legend from the design brief — the canonical status of a bill reduced
 * to a four-state traffic signal the UI colors consistently.
 *
 *   WATCH   introduced / referred
 *   CAUTION in committee
 *   CLEAR   passed / enacted
 *   STOP    failed / vetoed
 */
import type { BillStatus } from './canonical'

export const SIGNALS = ['watch', 'caution', 'clear', 'stop'] as const

export type Signal = (typeof SIGNALS)[number]

/**
 * bill_status → signal, per the legend above (and the enum comment in 0001).
 * The two statuses the legend doesn't name: `withdrawn` is a terminal dead end
 * like failed/vetoed → STOP; `unknown` hasn't earned anything past WATCH.
 */
export const STATUS_SIGNAL: Record<BillStatus, Signal> = {
  introduced: 'watch',
  referred: 'watch',
  unknown: 'watch',
  in_committee: 'caution',
  engrossed: 'caution',
  enrolled: 'caution',
  passed: 'clear',
  enacted: 'clear',
  vetoed: 'stop',
  failed: 'stop',
  withdrawn: 'stop',
}

export function signalForStatus(status: BillStatus): Signal {
  return STATUS_SIGNAL[status]
}

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
