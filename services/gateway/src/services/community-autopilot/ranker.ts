/**
 * VTID-04505 (Community Autopilot CA-5): the ranker. Pure.
 *
 * Owner decision 3: at most 3 open suggestions per member per role. On top:
 *   - one per category (a lineup is varied, never three health nags);
 *   - a never-used feature scores higher (the Autopilot teaches the system);
 *   - a template the member rejected twice in 30 days is suppressed;
 *   - a fingerprint that is already open, or was acted on / dismissed in the
 *     last 14 days, is not proposed again;
 *   - every row expires (by the next scan pass it is replaced, not stacked).
 */
import type { ScanCandidate, ScanCategory } from './scanners';

export const MAX_OPEN_PER_ROLE = 3;
export const REJECT_SUPPRESS_COUNT = 2;
export const REJECT_WINDOW_DAYS = 30;
export const RECENT_FINGERPRINT_DAYS = 14;
export const NOVELTY_BONUS = 15;
/** A scan row lives until a little after the next pass (07:00 / 17:00 local). */
export const SCAN_ROW_TTL_HOURS = 14;

export interface HistoryRow {
  fingerprint: string | null;
  /** The scan template (source_ref) of the row. */
  template: string | null;
  status: string;
  domain?: string | null;
  category?: string | null;
  updated_at: string;
}

export interface RankInput {
  candidates: ScanCandidate[];
  /** The member's community rows from the last 30 days, any status. */
  history: HistoryRow[];
  usedFeatures: Set<string>;
  now: Date;
}

export interface RankedCandidate extends ScanCandidate {
  score: number;
  novelty: boolean;
}

export interface RankResult {
  picks: RankedCandidate[];
  /** Why each dropped candidate was dropped (for the supervisor view / tests). */
  dropped: Array<{ fingerprint: string; reason: string }>;
  openSlots: number;
}

const DAY = 24 * 60 * 60 * 1000;
const OPEN = new Set(['new', 'snoozed', 'activated']);

export function rankCandidates(input: RankInput): RankResult {
  const { candidates, history, usedFeatures, now } = input;
  const dropped: RankResult['dropped'] = [];

  const openRows = history.filter((h) => OPEN.has(h.status));
  const openSlots = Math.max(0, MAX_OPEN_PER_ROLE - openRows.filter((h) => h.status !== 'activated').length);
  const openCategories = new Set(openRows.map((h) => h.category).filter(Boolean) as string[]);

  const rejectsByTemplate = new Map<string, number>();
  for (const h of history) {
    if (h.status !== 'rejected' || !h.template) continue;
    if (now.getTime() - Date.parse(h.updated_at) > REJECT_WINDOW_DAYS * DAY) continue;
    rejectsByTemplate.set(h.template, (rejectsByTemplate.get(h.template) ?? 0) + 1);
  }

  const blockedFingerprints = new Set<string>();
  for (const h of history) {
    if (!h.fingerprint) continue;
    if (OPEN.has(h.status)) { blockedFingerprints.add(h.fingerprint); continue; }
    if (now.getTime() - Date.parse(h.updated_at) <= RECENT_FINGERPRINT_DAYS * DAY) blockedFingerprints.add(h.fingerprint);
  }

  const eligible: RankedCandidate[] = [];
  for (const c of candidates) {
    if ((rejectsByTemplate.get(c.template) ?? 0) >= REJECT_SUPPRESS_COUNT) {
      dropped.push({ fingerprint: c.fingerprint, reason: 'template_rejected_twice' });
      continue;
    }
    if (blockedFingerprints.has(c.fingerprint)) {
      dropped.push({ fingerprint: c.fingerprint, reason: 'recent_or_open' });
      continue;
    }
    if (openCategories.has(c.category)) {
      dropped.push({ fingerprint: c.fingerprint, reason: 'category_already_open' });
      continue;
    }
    const novelty = !usedFeatures.has(c.feature);
    eligible.push({ ...c, novelty, score: c.baseScore + (novelty ? NOVELTY_BONUS : 0) });
  }

  eligible.sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint));

  const picks: RankedCandidate[] = [];
  const pickedCategories = new Set<ScanCategory>();
  for (const c of eligible) {
    if (picks.length >= openSlots) { dropped.push({ fingerprint: c.fingerprint, reason: 'cap_reached' }); continue; }
    if (pickedCategories.has(c.category)) { dropped.push({ fingerprint: c.fingerprint, reason: 'one_per_category' }); continue; }
    pickedCategories.add(c.category);
    picks.push(c);
  }
  return { picks, dropped, openSlots };
}
