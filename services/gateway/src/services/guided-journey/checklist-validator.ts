/**
 * VTID-03277 — Guided Journey checklist publish validator (P2).
 *
 * Pure function over the working topic set. Publish is BLOCKED unless this
 * returns ok=true. Rules mirror the curriculum spec + handoff Task 3 Step 2:
 *   - exactly 90 sessions and 250 topics
 *   - sessions 1-20 have 2 topics, 21-90 have 3
 *   - display labels are 1-4 words
 *   - every topic has a Vitana voice script
 *   - every topic has a guided practice target
 *   - business-area topics (session >= 60) carry a valid business gate
 */

import type {
  ChecklistTopic,
  ChecklistValidationResult,
  ChecklistValidationIssue,
  BusinessGate,
} from '../../types/journey-checklist';

const VALID_GATES: BusinessGate[] = ['curious', 'active', 'builder'];

function wordCount(label: string): number {
  return label.trim().split(/\s+/).filter(Boolean).length;
}

export function validateChecklist(topics: ChecklistTopic[]): ChecklistValidationResult {
  const errors: ChecklistValidationIssue[] = [];

  // Only enabled, non-disabled topics count toward a publishable curriculum.
  const active = topics.filter((t) => t.enabled && t.status !== 'disabled');

  const bySession = new Map<number, ChecklistTopic[]>();
  for (const t of active) {
    const list = bySession.get(t.session) ?? [];
    list.push(t);
    bySession.set(t.session, list);
  }

  const sessionCount = bySession.size;
  const topicCount = active.length;

  if (sessionCount !== 90) {
    errors.push({ rule: 'session_count', detail: `expected 90 sessions, found ${sessionCount}` });
  }
  if (topicCount !== 250) {
    errors.push({ rule: 'topic_count', detail: `expected 250 topics, found ${topicCount}` });
  }

  // Per-session card count.
  const wrongCounts: string[] = [];
  for (let s = 1; s <= 90; s++) {
    const list = bySession.get(s);
    if (!list) {
      errors.push({ rule: 'missing_session', detail: `session ${s} has no topics` });
      continue;
    }
    const expected = s <= 20 ? 2 : 3;
    if (list.length !== expected) {
      wrongCounts.push(`S${s}:${list.length}/${expected}`);
    }
    // Positions must be 1..n unique.
    const positions = list.map((t) => t.position).sort((a, b) => a - b);
    const expectedPositions = list.map((_, i) => i + 1);
    if (JSON.stringify(positions) !== JSON.stringify(expectedPositions)) {
      errors.push({
        rule: 'bad_positions',
        detail: `session ${s} positions must be 1..${list.length}`,
        topicIds: list.map((t) => t.topicId),
      });
    }
  }
  if (wrongCounts.length) {
    errors.push({
      rule: 'cards_per_session',
      detail: `sessions 1-20 need 2 topics, 21-90 need 3. Offenders: ${wrongCounts.join(', ')}`,
    });
  }

  // Label word count 1-4.
  const badLabels = active.filter((t) => {
    const n = wordCount(t.displayLabel);
    return n < 1 || n > 4;
  });
  if (badLabels.length) {
    errors.push({
      rule: 'label_word_count',
      detail: 'display labels must be 1-4 words',
      topicIds: badLabels.map((t) => t.topicId),
    });
  }

  // Voice script present.
  const noScript = active.filter((t) => !t.vitanaVoiceScript || !t.vitanaVoiceScript.trim());
  if (noScript.length) {
    errors.push({
      rule: 'missing_voice_script',
      detail: 'every topic needs a Vitana voice script',
      topicIds: noScript.map((t) => t.topicId),
    });
  }

  // Guided practice target present.
  const noTarget = active.filter((t) => !t.guidedPracticeTarget || !t.guidedPracticeTarget.trim());
  if (noTarget.length) {
    errors.push({
      rule: 'missing_practice_target',
      detail: 'every topic needs a guided practice target',
      topicIds: noTarget.map((t) => t.topicId),
    });
  }

  // Business gating: session >= 60 topics must carry a valid business gate;
  // any set gate must be in the allowed enum.
  const badGate = active.filter((t) => {
    if (t.businessGate != null && !VALID_GATES.includes(t.businessGate)) return true;
    if (t.session >= 60 && t.businessGate == null) return true;
    return false;
  });
  if (badGate.length) {
    errors.push({
      rule: 'business_gate',
      detail: 'business-area topics (session >= 60) must be gated curious|active|builder',
      topicIds: badGate.map((t) => t.topicId),
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: { sessionCount, topicCount, enabledCount: active.length },
  };
}
