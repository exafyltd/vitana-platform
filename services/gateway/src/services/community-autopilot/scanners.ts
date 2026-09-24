/**
 * VTID-04505 (Community Autopilot CA-5): area scanners.
 *
 * Each scanner reads one member's snapshot and proposes at most one candidate
 * with a typed action (CA-3 registry). Scanners are pure: all reads happen in
 * scan-runner.ts, so every rule here is unit-testable without a database.
 *
 * Categories keep the lineup varied (the ranker allows one per category):
 *   health · reflect · connect · community · create · explore · grow
 *
 * Titles and summaries are catalog keys (`autopilot.scan.<template>.*`),
 * rendered in the member's language by the runner. Draft text for create /
 * connect suggestions is written later by CA-4 from an English intent.
 */
import type { RecommendationAction } from './action-registry';

export type ScanCategory = 'health' | 'reflect' | 'connect' | 'community' | 'create' | 'explore' | 'grow';

export type ScanTemplate =
  | 'index_pillar'
  | 'diary_gap'
  | 'reply_message'
  | 'match_intro'
  | 'event_rsvp'
  | 'share_progress'
  | 'media_first'
  | 'discover_explore'
  | 'invite_friend'
  | 'health_inbox';

export type PillarKey = 'sleep' | 'nutrition' | 'exercise' | 'hydration' | 'mental';

export interface MemberSnapshot {
  userId: string;
  now: Date;
  /** Latest Vitana Index row, pillar scores 0-100 (null when never scored). */
  index: { total: number | null; pillars: Partial<Record<PillarKey, number | null>> } | null;
  lastDiaryAt: string | null;
  /** Oldest unread direct message from a real member, if any. */
  unreadFrom: { userId: string; name: string; sentAt: string } | null;
  /** Today's match the member has not looked at, if any. */
  freshMatch: { userId: string; name: string } | null;
  /** Next community event with free places in the coming days. */
  upcomingEvent: { id: string; title: string; startsAt: string } | null;
  postsLast14d: number;
  videosEver: number;
  /** Features the member has used at least once (for the novelty bonus). */
  usedFeatures: Set<string>;
  /** An unread item from the old recommendation inbox (health engine), folded in. */
  inboxItem: { id: string; title: string; body: string | null } | null;
}

export interface ScanCandidate {
  template: ScanTemplate;
  category: ScanCategory;
  /** Stable per target: the ranker and the DB dedupe on it. */
  fingerprint: string;
  /** Catalog params for the title/summary. */
  params: Record<string, string>;
  action: RecommendationAction;
  /** 0-100 before the ranker's adjustments. */
  baseScore: number;
  /** Feature key for the novelty bonus (never-used feature scores higher). */
  feature: string;
  domain: string;
  /** Literal title/summary (only for folded inbox items, already user-facing text). */
  literal?: { title: string; summary: string | null };
}

const DAY = 24 * 60 * 60 * 1000;
const daysSince = (iso: string | null, now: Date) => (iso ? (now.getTime() - Date.parse(iso)) / DAY : Infinity);

/** Which log action lifts which pillar. */
const PILLAR_ACTION: Record<PillarKey, RecommendationAction> = {
  hydration: { kind: 'log_water', params: { amount_ml: 250 } },
  sleep: { kind: 'open_screen', params: { route: '/health' } },
  exercise: { kind: 'log_exercise', params: { minutes: 15, activity_type: 'walk' } },
  mental: { kind: 'log_meditation', params: { minutes: 5 } },
  nutrition: { kind: 'open_screen', params: { route: '/health' } },
};

export function scanIndexPillar(s: MemberSnapshot): ScanCandidate | null {
  if (!s.index) return null;
  const entries = Object.entries(s.index.pillars).filter(([, v]) => typeof v === 'number') as Array<[PillarKey, number]>;
  if (entries.length === 0) return null;
  entries.sort((a, b) => a[1] - b[1]);
  const [pillar, score] = entries[0];
  if (score >= 70) return null;
  return {
    template: 'index_pillar', category: 'health', feature: 'vitana_index', domain: 'health',
    fingerprint: `index_pillar:${pillar}`,
    params: { pillar },
    action: PILLAR_ACTION[pillar],
    baseScore: 60 + Math.round((70 - score) / 2),
  };
}

export function scanDiaryGap(s: MemberSnapshot): ScanCandidate | null {
  const gap = daysSince(s.lastDiaryAt, s.now);
  if (gap < 3) return null;
  return {
    template: 'diary_gap', category: 'reflect', feature: 'diary', domain: 'wellness',
    fingerprint: 'diary_gap',
    params: {},
    // The diary stays in the member's own words: open it, never draft it.
    action: { kind: 'open_screen', params: { route: '/diary' } },
    baseScore: Number.isFinite(gap) ? 55 : 50,
  };
}

export function scanReplyMessage(s: MemberSnapshot): ScanCandidate | null {
  const u = s.unreadFrom;
  if (!u || daysSince(u.sentAt, s.now) < 0.5) return null;
  return {
    template: 'reply_message', category: 'connect', feature: 'messenger', domain: 'social',
    fingerprint: `reply_message:${u.userId}`,
    params: { name: u.name },
    action: { kind: 'send_chat_message', params: { recipient_user_id: u.userId, recipient_label: u.name, context: 'Reply to their last message.' } },
    baseScore: 80,
  };
}

export function scanMatchIntro(s: MemberSnapshot): ScanCandidate | null {
  const m = s.freshMatch;
  if (!m) return null;
  return {
    template: 'match_intro', category: 'connect', feature: 'matches', domain: 'community',
    fingerprint: `match_intro:${m.userId}`,
    params: { name: m.name },
    action: { kind: 'send_chat_message', params: { recipient_user_id: m.userId, recipient_label: m.name, context: 'First hello to a new match.' } },
    baseScore: 72,
  };
}

export function scanEventRsvp(s: MemberSnapshot): ScanCandidate | null {
  const e = s.upcomingEvent;
  if (!e) return null;
  return {
    template: 'event_rsvp', category: 'community', feature: 'events', domain: 'community',
    fingerprint: `event_rsvp:${e.id}`,
    params: { event: e.title },
    action: { kind: 'rsvp_event', params: { event_id: e.id, event_title: e.title } },
    baseScore: 65,
  };
}

export function scanShareProgress(s: MemberSnapshot): ScanCandidate | null {
  if (s.postsLast14d > 0 || !s.index || s.index.total == null) return null;
  return {
    template: 'share_progress', category: 'create', feature: 'news_feed', domain: 'content',
    fingerprint: 'share_progress',
    params: {},
    action: { kind: 'post_to_feed', params: { topic: `Vitana Index ${s.index.total}` } },
    baseScore: 50,
  };
}

export function scanMediaFirst(s: MemberSnapshot): ScanCandidate | null {
  if (s.videosEver > 0) return null;
  return {
    template: 'media_first', category: 'create', feature: 'media_hub', domain: 'media',
    fingerprint: 'media_first',
    params: {},
    action: { kind: 'media_upload', params: {} },
    baseScore: 40,
  };
}

export function scanDiscover(s: MemberSnapshot): ScanCandidate | null {
  if (s.usedFeatures.has('discover')) return null;
  return {
    template: 'discover_explore', category: 'explore', feature: 'discover', domain: 'discover',
    fingerprint: 'discover_explore',
    params: {},
    action: { kind: 'open_screen', params: { route: '/discover' } },
    baseScore: 35,
  };
}

export function scanInviteFriend(_s: MemberSnapshot): ScanCandidate | null {
  return {
    template: 'invite_friend', category: 'grow', feature: 'invite', domain: 'community',
    fingerprint: 'invite_friend',
    params: {},
    // CA-7 turns this into an attributed invite link; until then the popup opens the referral overlay.
    action: { kind: 'open_screen', params: { route: '/?open=invite' } },
    baseScore: 30,
  };
}

/** Owner decision 4: the old recommendation inbox is folded into the Autopilot queue. */
export function scanHealthInbox(s: MemberSnapshot): ScanCandidate | null {
  const r = s.inboxItem;
  if (!r) return null;
  return {
    template: 'health_inbox', category: 'health', feature: 'health_recommendations', domain: 'health',
    fingerprint: `health_inbox:${r.id}`,
    params: {},
    action: { kind: 'open_screen', params: { route: '/health' } },
    baseScore: 58,
    literal: { title: r.title, summary: r.body },
  };
}

export const SCANNERS: Array<(s: MemberSnapshot) => ScanCandidate | null> = [
  scanReplyMessage,
  scanMatchIntro,
  scanIndexPillar,
  scanHealthInbox,
  scanEventRsvp,
  scanDiaryGap,
  scanShareProgress,
  scanMediaFirst,
  scanDiscover,
  scanInviteFriend,
];

export function runScanners(s: MemberSnapshot): ScanCandidate[] {
  const out: ScanCandidate[] = [];
  for (const scan of SCANNERS) {
    try {
      const c = scan(s);
      if (c) out.push(c);
    } catch {
      // One broken scanner never stops the others.
    }
  }
  return out;
}
