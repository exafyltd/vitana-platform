/**
 * VTID-04443 (Plan v1 WS-4.4) — the conversation replay test set.
 *
 * Every case under test/fixtures/conversation-replay/cases is replayed through
 * the real decision functions. Each case must meet its own expectations, and
 * its whole transcript is snapshotted: a conversation-logic change that alters
 * any replayed decision fails here (CI runs jest with --ci, so a changed or
 * missing snapshot fails) until the snapshot is updated deliberately and the
 * diff reviewed. Run on its own with `npm run test:replay`.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  REPLAY_CASE_SCHEMA_VERSION,
  caseSkeletonFromInspector,
  checkReplayExpectations,
  replayConversation,
  transcriptForSnapshot,
  type ReplayCase,
} from '../../../src/services/conversation/replay/conversation-replay';

const CASES_DIR = join(__dirname, '../../fixtures/conversation-replay/cases');
const cases: ReplayCase[] = readdirSync(CASES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')));

describe('the case set', () => {
  it('has cases, unique ids matching their files, and the current schema', () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
    const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();
    expect(cases.map((c) => `${c.id}.json`)).toEqual(files);
    for (const c of cases) expect(c.schema_version).toBe(REPLAY_CASE_SCHEMA_VERSION);
  });

  it('holds no personal data: synthetic or consented, no ids, no emails, no UUIDs', () => {
    for (const c of cases) {
      if (c.source.kind === 'recorded') expect(c.source.consent_ref.trim().length).toBeGreaterThan(0);
      else expect(c.source.kind).toBe('synthetic');
      const raw = JSON.stringify(c);
      expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(raw).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
      expect(raw).not.toMatch(/"(user_id|session_id|tenant_id)"/);
    }
  });

  it('covers the parts of the brain this set exists to protect', () => {
    const openers = new Set(cases.map((c) => c.expect.opener_kind));
    for (const o of ['override_v2', 'legacy_default', 'silent_reconnect', 'safe_fast_first_time_welcome']) expect(openers).toContain(o);
    expect(cases.some((c) => c.expect.candidate_spoken === true)).toBe(true);
    expect(cases.some((c) => c.expect.candidate_spoken === false && c.expect.candidate_provider)).toBe(true);
    expect(cases.some((c) => (c.expect.turns ?? []).some((t) => t?.find_tool_top))).toBe(true);
    expect(cases.some((c) => (c.expect.turns ?? []).some((t) => t?.advisor_eligible === false))).toBe(true);
    expect(cases.some((c) => c.personal_weights_live)).toBe(true);
  });
});

describe.each(cases.map((c) => [c.id, c] as const))('replay %s', (_id, c) => {
  const t = replayConversation(c);

  it('meets its expectations', () => {
    expect(checkReplayExpectations(c, t)).toEqual([]);
  });

  it('is deterministic', () => {
    expect(transcriptForSnapshot(replayConversation(c))).toEqual(transcriptForSnapshot(t));
  });

  it('matches its recorded transcript', () => {
    expect(transcriptForSnapshot(t)).toMatchSnapshot();
  });
});

describe('checkReplayExpectations', () => {
  const c = cases.find((x) => x.id === 'returning-wallet-balance')!;

  it('reports each broken expectation', () => {
    const wrong: ReplayCase = {
      ...c,
      expect: {
        opener_kind: 'legacy_default',
        candidate_spoken: false,
        turns: [{ declared_tools_include: ['not_a_tool'], find_tool_top: 'x', advisor_eligible: false }],
      },
    };
    const f = checkReplayExpectations(wrong, replayConversation(wrong));
    expect(f).toEqual(expect.arrayContaining([
      expect.stringMatching(/^opener_kind: expected "legacy_default"/),
      expect.stringMatching(/^candidate_spoken:/),
      expect.stringMatching(/tool not_a_tool not declared/),
      expect.stringMatching(/find_tool top expected x/),
      expect.stringMatching(/turn 0 advisor_eligible/),
    ]));
  });

  it('always fails an opening that asks the model to recite', () => {
    const t = replayConversation(c);
    t.opening.recital_directive = true;
    expect(checkReplayExpectations({ ...c, expect: {} }, t)).toContain('opening directive asks the model to recite text (NEVER-rule 41)');
  });
});

describe('recording a case from a consented session', () => {
  const summary = {
    session_id: 'live-abc',
    user: { user_id: '00000000-0000-4000-8000-000000000001', lang: 'de', transport: 'ws', origin: 'https://x' },
    decision: [{ wake_opener: 'override_v2', current_route: '/wallet?tab=1', candidate_provider: 'login_briefing' }],
    candidates: { providers: [
      { key: 'login_briefing', status: 'returned', latency_ms: 40 },
      { key: 'journey_guide', status: 'suppressed', reason: 'x' },
      { key: 'bogus', status: 'weird' },
    ] },
  };

  it('refuses without a consent reference or with a bad id', () => {
    expect(() => caseSkeletonFromInspector(summary, { id: 'a-case', consentRef: ' ', recordedAt: '2026-09-23' })).toThrow(/consent/);
    expect(() => caseSkeletonFromInspector(summary, { id: 'Bad Id', consentRef: 'ticket-1', recordedAt: '2026-09-23' })).toThrow(/case id/);
  });

  it('keeps what the brain decided from and nothing that identifies the member', () => {
    const c = caseSkeletonFromInspector(summary, { id: 'wallet-recorded', consentRef: 'consent-2026-09-23-01', recordedAt: '2026-09-23' });
    expect(c.source).toEqual({ kind: 'recorded', consent_ref: 'consent-2026-09-23-01', recorded_at: '2026-09-23' });
    expect(c.opening.greeting).toMatchObject({ lang: 'de', greetLang: 'de', currentRoute: '/wallet', wakeBriefHasSelectedContinuation: true });
    expect(c.opening.greeting!.openDecision!.line).toMatch(/synthetic placeholder/);
    expect(c.opening.providers!.map((p) => [p.providerKey, p.status])).toEqual([['login_briefing', 'returned'], ['journey_guide', 'suppressed']]);
    expect(c.opening.winner).toBe('login_briefing');
    expect(c.expect.opener_kind).toBe('override_v2');
    const raw = JSON.stringify(c);
    expect(raw).not.toContain('live-abc');
    expect(raw).not.toContain('00000000-0000-4000-8000-000000000001');
    expect(raw).not.toContain('https://x');
    expect(checkReplayExpectations(c, replayConversation(c))).toEqual([]);
  });
});
