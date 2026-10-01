/**
 * VTID-04420 (Plan v1 WS-2.1) — providers are the brain's candidate sources,
 * the greeting rungs are the phrasing layer, and every opening records which
 * candidate won and whether it was spoken.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveCandidateOutcome } from '../../../src/services/conversation/decide-conversation-flow';
import { withGreetingMonitorFields } from '../../../src/services/conversation/greeting-monitor-fields';
import {
  PHRASING_RULE,
  buildOpeningIntentDirective,
  isVerbatimRecitationDirective,
} from '../../../src/services/conversation/phrasing-rule';

const winner = { id: 'c-1', kind: 'wake_brief', dedupeKey: 'login_briefing:messages' };
const decision = {
  selectedContinuation: winner,
  sourceProviderResults: [
    { providerKey: 'journey_guide', status: 'suppressed' },
    { providerKey: 'login_briefing', status: 'returned', candidate: winner },
    { providerKey: 'unread_messages_announce', status: 'returned', candidate: { id: 'c-2' } },
  ],
};

describe('resolveCandidateOutcome', () => {
  it('override_v2 speaks the winning candidate', () => {
    expect(resolveCandidateOutcome('override_v2', decision)).toEqual({
      candidate_provider: 'login_briefing',
      candidate_kind: 'wake_brief',
      candidate_key: 'login_briefing:messages',
      candidate_spoken: true,
      candidate_outranked_by: null,
      candidates_returned: 2,
    });
  });

  it('any other rung outranks the winner and is named', () => {
    const o = resolveCandidateOutcome('newday_overview', decision);
    expect(o.candidate_provider).toBe('login_briefing');
    expect(o.candidate_spoken).toBe(false);
    expect(o.candidate_outranked_by).toBe('newday_overview');
  });

  it('matches the winner by id when the object was copied', () => {
    const copied = { ...decision, selectedContinuation: { ...winner } };
    expect(resolveCandidateOutcome('override_v2', copied).candidate_provider).toBe('login_briefing');
  });

  it('no candidate: no provider, nothing outranked', () => {
    const none = {
      selectedContinuation: { kind: 'none_with_reason' },
      sourceProviderResults: [{ providerKey: 'journey_guide', status: 'suppressed' }],
    };
    expect(resolveCandidateOutcome('conv_resume', none)).toEqual({
      candidate_provider: null,
      candidate_kind: null,
      candidate_key: null,
      candidate_spoken: false,
      candidate_outranked_by: null,
      candidates_returned: 0,
    });
    expect(resolveCandidateOutcome('conv_resume', null).candidates_returned).toBe(0);
  });

  it('the legacy default tail (no wake_opener) is reported as legacy_default', () => {
    expect(resolveCandidateOutcome(null, decision).candidate_outranked_by).toBe('legacy_default');
  });
});

describe('greeting_sent carries the candidate columns', () => {
  it('adds them next to the Monitor columns without touching rung fields', () => {
    const out = withGreetingMonitorFields(
      { wake_opener: 'override_v2', prompt_len: 40 },
      { lang: 'de', candidate: { ...resolveCandidateOutcome('override_v2', decision) } },
    );
    expect(out.candidate_provider).toBe('login_briefing');
    expect(out.candidate_spoken).toBe(true);
    expect(out.prompt_len).toBe(40);
  });

  it('omitting the candidate adds no columns', () => {
    const out = withGreetingMonitorFields({ wake_opener: 'conv_resume' }, { lang: 'de' });
    expect(out).not.toHaveProperty('candidate_provider');
  });

  it('both greeting_sent emits in orb-live.ts pass the candidate outcome', () => {
    const orbLive = readFileSync(join(__dirname, '../../../src/routes/orb-live.ts'), 'utf8');
    const hits = orbLive.match(/candidate: \{ \.\.\.resolveCandidateOutcome\((_sfDecision|decision)\.wakeOpener, \(session as any\)\.wakeBriefDecision\) \}/g) || [];
    expect(hits).toHaveLength(2);
  });
});

describe('phrasing rule', () => {
  it('builds an intent directive that ends with the one rule', () => {
    const d = buildOpeningIntentDirective('Greet them by name.');
    expect(d).toContain('INTENT: Greet them by name.');
    expect(d).toContain(PHRASING_RULE);
    expect(isVerbatimRecitationDirective(d)).toBe(false);
  });

  it('the rule is stated positively (no prohibition stack, VTID-04124)', () => {
    expect(PHRASING_RULE).not.toMatch(/\b(do not|don't|never|NOT)\b/);
  });
});
