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

/** `tracked_position` — the stance a tracked bill is held with. */
export const TRACKED_POSITIONS = ['support', 'oppose', 'watch'] as const
export const trackedPositionSchema = z.enum(TRACKED_POSITIONS)
export type TrackedPosition = z.infer<typeof trackedPositionSchema>

/** `alert_channel` — where a tracked bill's alerts fan out (in-app is always on). */
export const ALERT_CHANNELS = ['in_app', 'email', 'both'] as const
export const alertChannelSchema = z.enum(ALERT_CHANNELS)
export type AlertChannel = z.infer<typeof alertChannelSchema>

/** `alert_change_type` — what the differ decided moved. */
export const ALERT_CHANGE_TYPES = [
  'new_action',
  'status_change',
  'new_sponsor',
  'vote',
  'hearing',
] as const
export const alertChangeTypeSchema = z.enum(ALERT_CHANGE_TYPES)
export type AlertChangeType = z.infer<typeof alertChangeTypeSchema>

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

/**
 * `contact_type` — a CRM contact is a person or an organization (ITLK-21).
 *
 * Orgs (CMAP, CDOT, a community group) are correspondence targets, always hand-added, so
 * ingest never touches them. `role` belongs to a person, `org_type` to an org.
 */
export const CONTACT_TYPES = ['person', 'org'] as const
export const contactTypeSchema = z.enum(CONTACT_TYPES)
export type ContactType = z.infer<typeof contactTypeSchema>

/** `org_type` — an organization's kind, the way `official_role` is a person's seat. */
export const ORG_TYPES = ['agency', 'media', 'advocacy', 'community_group', 'other'] as const
export const orgTypeSchema = z.enum(ORG_TYPES)
export type OrgType = z.infer<typeof orgTypeSchema>

/** `letter_direction` — did we send it, or did it arrive? */
export const LETTER_DIRECTIONS = ['sent', 'received'] as const
export const letterDirectionSchema = z.enum(LETTER_DIRECTIONS)
export type LetterDirection = z.infer<typeof letterDirectionSchema>

/**
 * `letter_channel` — how the exchange happened. `phone` and `in_person` are why the ledger
 * is a correspondence log and not an email client: a logged call is a first-class row with
 * no email-shaped fields required of it.
 */
export const LETTER_CHANNELS = ['email', 'mail', 'web_form', 'phone', 'in_person'] as const
export const letterChannelSchema = z.enum(LETTER_CHANNELS)
export type LetterChannel = z.infer<typeof letterChannelSchema>

/** `letter_status` — the ledger's lifecycle: draft → sent → responded → closed. */
export const LETTER_STATUSES = ['draft', 'sent', 'responded', 'closed'] as const
export const letterStatusSchema = z.enum(LETTER_STATUSES)
export type LetterStatus = z.infer<typeof letterStatusSchema>

/** `letter_official_role` — how an official featured in one exchange. */
export const LETTER_OFFICIAL_ROLES = ['recipient', 'sender', 'cc'] as const
export const letterOfficialRoleSchema = z.enum(LETTER_OFFICIAL_ROLES)
export type LetterOfficialRole = z.infer<typeof letterOfficialRoleSchema>
