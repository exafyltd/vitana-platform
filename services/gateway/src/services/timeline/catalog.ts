/**
 * VTID-05167 — Timeline catalog (Life Timeline P1).
 *
 * Every `user_activity_log.activity_type` is classified exactly once, here,
 * into a tier (what the member sees), a category/topic (how it is grouped)
 * and — when the Vitana Index counts it — a pillar. The same JSON seeds the
 * `activity_catalog` table that the `classify_activity()` trigger reads, so
 * the gateway and the database can never disagree (parity test:
 * test/vtid-05167-timeline-catalog.test.ts).
 *
 * Tiers:
 *   spotlight — the Vitana Index and what moved it
 *   moment    — one card each on the timeline
 *   digest    — only inside the daily "Your day" card
 *   silent    — stored for learning (habits), never listed
 *   system    — internal telemetry; never written to user_activity_log
 *
 * Lookup: exact type first, then the longest matching prefix entry, then the
 * default (silent). An unknown type is never shown to a member.
 */
import catalogJson from './timeline-catalog.json';

export const TIMELINE_TIERS = ['spotlight', 'moment', 'digest', 'silent', 'system'] as const;
export type TimelineTier = (typeof TIMELINE_TIERS)[number];

export type TimelinePillar = 'nutrition' | 'hydration' | 'exercise' | 'sleep' | 'mental';

export interface TimelineCatalogEntry {
  type: string;
  match: 'exact' | 'prefix';
  tier: TimelineTier;
  category: string;
  topic: string;
  pillar: TimelinePillar | null;
  secondary_pillar: TimelinePillar | null;
  icon: string;
  sensitivity: 'standard' | 'special_category';
  summary_key: string;
  params: string[];
}

export type TimelineClassification = Omit<TimelineCatalogEntry, 'type' | 'match'> & {
  /** The catalog entry that matched, or null when the default applied. */
  matched: string | null;
};

interface CatalogFile {
  version: number;
  tiers: string[];
  pillars: string[];
  categories: string[];
  default: Omit<TimelineCatalogEntry, 'type' | 'match'>;
  entries: TimelineCatalogEntry[];
}

const CATALOG = catalogJson as unknown as CatalogFile;

const EXACT = new Map<string, TimelineCatalogEntry>();
const PREFIXES: TimelineCatalogEntry[] = [];
for (const entry of CATALOG.entries) {
  if (entry.match === 'prefix') PREFIXES.push(entry);
  else EXACT.set(entry.type, entry);
}
// Longest prefix wins.
PREFIXES.sort((a, b) => b.type.length - a.type.length);

export function getTimelineCatalog(): Readonly<CatalogFile> {
  return CATALOG;
}

export function classifyActivityType(activityType: string): TimelineClassification {
  const t = (activityType || '').toLowerCase();
  const hit = EXACT.get(t) ?? PREFIXES.find((p) => t.startsWith(p.type));
  if (!hit) return { ...CATALOG.default, matched: null };
  const { type, match: _match, ...rest } = hit;
  return { ...rest, matched: type };
}

/** System telemetry stays in oasis_events only; it never reaches a member's history. */
export function isTimelineProjectable(activityType: string): boolean {
  return classifyActivityType(activityType).tier !== 'system';
}
