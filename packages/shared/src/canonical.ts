import { z } from 'zod'

/**
 * TypeScript mirrors of the canonical Postgres enums (migration 0001).
 *
 * Same discipline as `SOURCES` in seam.ts: the database is the source of truth,
 * and these arrays exist so adapters can't invent a value the column would
 * reject. Adding a value here means adding it with `ALTER TYPE ... ADD VALUE`
 * too — and vice versa.
 */

/** `bill_status` — the canonical stage, across both sources. */
export const BILL_STATUSES = [
  'introduced',
  'referred',
  'in_committee',
  'engrossed',
  'enrolled',
  'passed',
  'enacted',
  'vetoed',
  'failed',
  'withdrawn',
  'unknown',
] as const
export const billStatusSchema = z.enum(BILL_STATUSES)
export type BillStatus = z.infer<typeof billStatusSchema>

/** `action_classification` — what a history row actually did. */
export const ACTION_CLASSIFICATIONS = [
  'introduced',
  'referred',
  'hearing',
  'amendment',
  'vote',
  'passage',
  'failure',
  'veto',
  'signed',
  'withdrawn',
  'other',
] as const
export const actionClassificationSchema = z.enum(ACTION_CLASSIFICATIONS)
export type ActionClassification = z.infer<typeof actionClassificationSchema>

/** `sponsor_type` — lead vs. co-sponsor. */
export const SPONSOR_TYPES = ['primary', 'chief_co', 'co'] as const
export const sponsorTypeSchema = z.enum(SPONSOR_TYPES)
export type SponsorType = z.infer<typeof sponsorTypeSchema>

/** `jurisdiction` — the body a bill belongs to. */
export const JURISDICTIONS = ['chicago_council', 'il_ga'] as const
export const jurisdictionSchema = z.enum(JURISDICTIONS)
export type Jurisdiction = z.infer<typeof jurisdictionSchema>

/** `official_role` — us_rep/us_sen/other exist for manually-added federal contacts. */
export const OFFICIAL_ROLES = [
  'alder',
  'state_rep',
  'state_sen',
  'mayor',
  'us_rep',
  'us_sen',
  'other',
] as const
export const officialRoleSchema = z.enum(OFFICIAL_ROLES)
export type OfficialRole = z.infer<typeof officialRoleSchema>
