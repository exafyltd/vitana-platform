/**
 * VTID-04883: community ranking decisions D1–D3, D5–D8 in shadow. Jev calls are injected; the shadow
 * table, OASIS and Supabase are fakes.
 */
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));

import { readFileSync } from 'fs';
import { join } from 'path';
import { getJevDecision, RANKING_SLOTS } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl } from '../src/services/jev/jev-tenant-control';
import {
  COMMUNITY_RANKING_GATES,
  RANKING_GATES,
  isSampled,
  rankingSampleRate,
  runRankingShadow,
  shadowCalendarPriority,
  shadowFeedPick,
  shadowMatchRerank,
  shadowMemberTiebreak,
  shadowNextAction,
  shadowNotificationWorth,
  shadowSuggestionPick,
} from '../src/services/jev/gates/community-ranking-gates';
import type { JevCallResult } from '../src/services/jev/jev-client';

const TENANT = 't1';
const MEMBER = '11111111-2222-4333-8444-555555555555';
const FLAG = { enabled: true, planes: ['internal', 'system_autopilot', 'member'], monthly_budget_usd: 50 };
const ON = {
  JEV_DECISIONS_ENABLED: 'true',
  TYPESAFE_API_KEY: 'k',
  JEV_COMMUNITY_ENABLED: 'true',
  JEV_COMMUNITY_CALENDAR_PRIORITY_MODE: 'shadow',
  JEV_COMMUNITY_NEXT_ACTION_MODE: 'shadow',
  JEV_COMMUNITY_MATCH_RERANK_MODE: 'shadow',
  JEV_COMMUNITY_SUGGESTION_PICK_MODE: 'shadow',
  JEV_COMMUNITY_NOTIFICATION_WORTH_MODE: 'shadow',
  JEV_COMMUNITY_NOTIFICATION_WORTH_SAMPLE: '1',
  JEV_COMMUNITY_FEED_PICK_MODE: 'shadow',
  JEV_COMMUNITY_FEED_PICK_SAMPLE: '1',
  JEV_COMMUNITY_MEMBER_TIEBREAK_MODE: 'shadow',
} as NodeJS.ProcessEnv;

const pick = (slot: string, p = 0.9) => ({ pick: { type: 'choice', choice: slot, probabilities: { [slot]: p }, confidence: p } });
const ok = (answers: any): JevCallResult => ({ ok: true, model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 2 }, latency_ms: 5, attempts: 1 });

function deps(answers: any, env: NodeJS.ProcessEnv = ON) {
  const rows: any[] = [];
  const call = jest.fn().mockResolvedValue(ok(answers));
  const bumps: Array<[string, string]> = [];
  return {
    rows,
    call,
    bumps,
    d: {
      env,
      decideOptions: {
        call,
        control: createMemoryJevControl({ [TENANT]: FLAG }).control,
        communityRate: { admit: () => true },
        quota: { bump: async (t: string, m: string) => (bumps.push([t, m]), 1) },
      } as any,
      record: jest.fn(async (r: any) => {
        rows.push(r);
        return `row-${rows.length}`;
      }),
    },
  };
}

const cands = (n: number) => Array.from({ length: n }, (_, i) => ({ score: 100 - i }));
const base = (n = 3) => ({
  gate: RANKING_GATES.suggestion,
  tenantId: TENANT,
  memberId: MEMBER,
  subjectType: 'test',
  subjectRef: 'ref',
  context: {},
  candidates: cands(n),
});

describe('VTID-04883 decisions', () => {
  test('six choice decisions over c1…c8 and one noul, all member content Class B, PII redacted', () => {
    expect(COMMUNITY_RANKING_GATES).toHaveLength(7);
    for (const n of COMMUNITY_RANKING_GATES) {
      const d = getJevDecision(n)!;
      expect(d).toMatchObject({ data: 'member_content', community_class: 'B', pii: 'redact' });
      expect([...d.planes]).toEqual(['internal', 'system_autopilot']);
      expect(d.safety).toBeUndefined();
    }
    for (const n of COMMUNITY_RANKING_GATES.filter((g) => g !== RANKING_GATES.notification)) {
      const q = (getJevDecision(n)!.questions as any).pick;
      expect(q.type).toBe('choice');
      expect(Object.keys(q.criteria)).toEqual([...RANKING_SLOTS]);
    }
    expect((getJevDecision(RANKING_GATES.notification)!.questions as any).worth.type).toBe('noul');
  });

  test('inputs accept at most 8 flat candidates', () => {
    const d = getJevDecision(RANKING_GATES.calendar)!;
    expect(d.input.safeParse({ context: {}, candidates: cands(8) }).success).toBe(true);
    expect(d.input.safeParse({ context: {}, candidates: cands(9) }).success).toBe(false);
    expect(d.input.safeParse({ context: {}, candidates: [{ nested: { a: 1 } }] }).success).toBe(false);
  });
});

describe('VTID-04883 gates skip unless shadow + community + tenant + member', () => {
  test('no Jev call and no row', async () => {
    const cases: Array<[NodeJS.ProcessEnv, any]> = [
      [{ ...ON, JEV_COMMUNITY_SUGGESTION_PICK_MODE: 'off' } as any, base()],
      [{ ...ON, JEV_COMMUNITY_ENABLED: 'false' } as any, base()],
      [ON, { ...base(), tenantId: null }],
      [ON, { ...base(), memberId: null }],
      [ON, { ...base(), candidates: [] }],
    ];
    for (const [env, call] of cases) {
      const t = deps(pick('c1'), env);
      expect(await runRankingShadow(call, t.d)).toBeNull();
      expect(t.call).not.toHaveBeenCalled();
      expect(t.rows).toEqual([]);
    }
  });
});

describe('VTID-04883 runner', () => {
  test('agreement on the existing top-1; member plane; quota counted for the member', async () => {
    const t = deps(pick('c1'));
    expect(await runRankingShadow(base(), t.d)).toBe('row-1');
    expect(t.rows[0]).toMatchObject({ gate: RANKING_GATES.suggestion, plane: 'member', tenant_id: TENANT, agreed: true, system_action: 'existing_c1' });
    expect(t.bumps).toEqual([[TENANT, MEMBER]]);
    expect(JSON.stringify(t.rows[0])).not.toContain(MEMBER);
  });

  test('a different pick disagrees; a pick beyond the list is not counted', async () => {
    const t = deps(pick('c3'));
    await runRankingShadow(base(), t.d);
    expect(t.rows[0]).toMatchObject({ agreed: false });
    const t2 = deps(pick('c7'));
    await runRankingShadow(base(3), t2.d);
    expect(t2.rows[0]).toMatchObject({ agreed: null });
    expect(t2.rows[0].jev_verdict.valid_pick).toBe(false);
  });

  test('more than 8 candidates are cut and flagged', async () => {
    const t = deps(pick('c2'));
    await runRankingShadow(base(12), t.d);
    const state = (t.call.mock.calls[0][0] as any).state;
    expect(state.candidates).toHaveLength(8);
    expect(state.member_context).toMatchObject({ candidate_count: 12, truncated: true });
    expect(t.rows[0].jev_verdict).toMatchObject({ truncated: true, candidate_count: 12 });
  });

  test('never throws: failing Jev call or shadow insert', async () => {
    const t = deps(pick('c1'));
    t.call.mockRejectedValue(new Error('boom'));
    const r = await runRankingShadow(base(), t.d);
    expect(r === null || r === 'row-1').toBe(true);
    const t2 = deps(pick('c1'));
    t2.d.record = jest.fn(async () => {
      throw new Error('db down');
    });
    await expect(runRankingShadow(base(), t2.d)).resolves.toBeNull();
  });
});

describe('VTID-04883 sampling', () => {
  test('deterministic by subject, 0 and 1 are absolute, rate read per gate', () => {
    expect(isSampled('a', 0)).toBe(false);
    expect(isSampled('a', 1)).toBe(true);
    const hits = Array.from({ length: 2000 }, (_, i) => isSampled(`s${i}`, 0.1)).filter(Boolean).length;
    expect(hits).toBeGreaterThan(120);
    expect(hits).toBeLessThan(280);
    expect(isSampled('same', 0.1)).toBe(isSampled('same', 0.1));
    expect(rankingSampleRate(RANKING_GATES.feed, {} as any)).toBe(0.1);
    expect(rankingSampleRate(RANKING_GATES.feed, { JEV_COMMUNITY_FEED_PICK_SAMPLE: '0.25' } as any)).toBe(0.25);
    expect(rankingSampleRate(RANKING_GATES.feed, { JEV_COMMUNITY_FEED_PICK_SAMPLE: '7' } as any)).toBe(0.1);
  });

  test('a sample rate of 0 makes the sampled gates silent', async () => {
    const t = deps({ worth: { type: 'noul', noul: 0.9 } }, { ...ON, JEV_COMMUNITY_NOTIFICATION_WORTH_SAMPLE: '0', JEV_COMMUNITY_FEED_PICK_SAMPLE: '0' } as any);
    await shadowNotificationWorth({ tenantId: TENANT, userId: MEMBER, notificationId: 'n1', type: 'x', category: 'c', priority: 'p2', channel: 'push', pushed: true, dnd: false }, t.d);
    await shadowFeedPick({ tenantId: TENANT, userId: MEMBER, requestRef: 'r', lifecycleStage: 's', regionGroup: 'EU', items: [{ category: 'a' }] }, t.d);
    expect(t.call).not.toHaveBeenCalled();
  });
});

describe('VTID-04883 per-gate state: no names, no member text beyond the D8 search, no health values', () => {
  test('D1 orders by the new score and sends bands, not titles', async () => {
    const t = deps(pick('c1'));
    await shadowCalendarPriority(
      {
        tenantId: TENANT,
        userId: MEMBER,
        weakestPillar: 'sleep',
        now: new Date('2026-10-07T10:00:00Z'),
        events: [
          { id: 'e1', score: 55, event_type: 'social', start_time: '2026-10-10T10:00:00Z' },
          { id: 'e2', score: 80, event_type: 'workout', pillar: 'exercise', start_time: '2026-10-07T18:00:00Z' },
        ],
      },
      t.d,
    );
    const state = (t.call.mock.calls[0][0] as any).state;
    expect(state.candidates.map((c: any) => c.existing_score)).toEqual([80, 55]);
    expect(state.candidates[0]).toMatchObject({ starts: 'within_24h', pillar: 'exercise' });
    expect(state.member_context.weakest_pillar).toBe('sleep');
    expect(t.rows[0].agreed).toBe(true);
  });

  test('D2 compares with the composer\'s chosen source; nothing chosen → not counted', async () => {
    const slate = [
      { source: 'reminder_due', priority: 70, confidence: 'high', reasonCount: 2 },
      { source: 'journey', priority: 90, confidence: 'medium', reasonCount: 1 },
    ];
    const t = deps(pick('c1'));
    await shadowNextAction({ tenantId: TENANT, userId: MEMBER, surface: 'orb_wake', chosenSource: 'journey', slate }, t.d);
    expect(t.rows[0]).toMatchObject({ agreed: true, system_action: 'existing_c1' });
    const t2 = deps(pick('c1'));
    await shadowNextAction({ tenantId: TENANT, userId: MEMBER, surface: 'orb_wake', chosenSource: null, slate }, t2.d);
    expect(t2.rows[0]).toMatchObject({ agreed: null, system_action: 'existing_none' });
  });

  test('D3 sends fit components and a title length band, never the title', async () => {
    const t = deps(pick('c2'));
    await shadowMatchRerank(
      {
        tenantId: TENANT,
        userId: MEMBER,
        intentKind: 'activity_seek',
        category: 'dance.salsa',
        candidates: [
          { cand_kind: 'activity_seek', cand_title: 'Salsa with Marta on Fridays', score: 0.8, reasons: { location_fit: 0.9, activity_exact: true } },
          { cand_kind: 'activity_seek', cand_title: 'Tango night', score: 0.6, reasons: {} },
        ],
      },
      t.d,
    );
    const sent = JSON.stringify(t.call.mock.calls[0][0]);
    expect(sent).not.toContain('Marta');
    expect(sent).not.toContain('Tango');
    expect(t.rows[0]).toMatchObject({ gate: RANKING_GATES.matchRerank, agreed: false });
  });

  test('D5 keeps the ranked order', async () => {
    const t = deps(pick('c1'));
    await shadowSuggestionPick(
      { tenantId: TENANT, userId: MEMBER, runId: 'run1', suggestions: [{ domain: 'sleep', source_type: 'community', impact_score: 8, effort_score: 2, risk_level: 'low', time_estimate_seconds: 600 }] },
      t.d,
    );
    expect((t.call.mock.calls[0][0] as any).state.candidates[0]).toMatchObject({ domain: 'sleep', minutes: 10 });
  });

  test('D6 agrees when Jev says it was worth sending; no title or body is sent', async () => {
    const t = deps({ worth: { type: 'noul', noul: 0.9 } });
    await shadowNotificationWorth({ tenantId: TENANT, userId: MEMBER, notificationId: 'n1', type: 'diary_reminder', category: 'health', priority: 'p2', channel: 'push_and_inapp', pushed: true, dnd: false }, t.d);
    expect(t.rows[0]).toMatchObject({ gate: RANKING_GATES.notification, agreed: true, system_action: 'existing_sent' });
    expect(t.bumps).toEqual([[TENANT, MEMBER]]);
    const t2 = deps({ worth: { type: 'noul', noul: 0.9 } });
    await shadowNotificationWorth({ tenantId: TENANT, userId: MEMBER, notificationId: null, type: 'x', category: 'c', priority: 'p2', channel: 'push', pushed: true, dnd: false }, t2.d);
    expect(t2.call).not.toHaveBeenCalled();
  });

  test('D7 skips guests (no member)', async () => {
    const t = deps(pick('c1'));
    await shadowFeedPick({ tenantId: TENANT, userId: null, requestRef: 'r', lifecycleStage: 's', regionGroup: 'EU', items: [{ category: 'a' }] }, t.d);
    expect(t.call).not.toHaveBeenCalled();
  });

  test('D8 puts the hash pick first and sends no member names', async () => {
    const t = deps(pick('c1'));
    const pool = [
      { user_id: 'u1', city: 'Vienna', country: 'AT', registration_seq: 5 },
      { user_id: 'u2', city: 'Graz', country: 'AT', registration_seq: 9 },
      { user_id: 'u3', city: 'Berlin', country: 'DE', registration_seq: 2 },
    ];
    await shadowMemberTiebreak({ tenantId: TENANT, viewerId: MEMBER, query: 'someone in Vienna', lane: 'floor', viewerCity: 'Vienna', viewerCountry: 'AT', pool, pickUserId: 'u2' }, t.d);
    const state = (t.call.mock.calls[0][0] as any).state;
    expect(state.candidates.map((c: any) => c.registration_seq)).toEqual([9, 2, 5]);
    expect(JSON.stringify(state)).not.toMatch(/u1|u2|u3/);
    expect(t.rows[0].agreed).toBe(true);
  });
});

describe('VTID-04883 wiring', () => {
  const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');
  const after = (file: string, anchor: string, call: RegExp) => {
    const s = src(file);
    const a = s.indexOf(anchor);
    expect(a).toBeGreaterThan(-1);
    const m = call.exec(s);
    expect(m).not.toBeNull();
    expect(m!.index).toBeGreaterThan(a);
  };

  test('every call site is fire-and-forget with its own catch, after the existing result is final', () => {
    after('src/services/calendar-prioritizer.ts', "method: 'PATCH'", /shadowCalendarPriority\(/);
    expect(src('src/services/calendar-prioritizer.ts')).toMatch(/void \(async \(\) => \{[\s\S]+?shadowCalendarPriority\([\s\S]+?\}\)\(\)\.catch\(\(\) => undefined\);/);
    after('src/services/assistant-continuation/providers/next-action/composer.ts', 'const ranked = rank(results);', /void shadowNextAction\([\s\S]+?\)\.catch\(\(\) => undefined\);/);
    after('src/services/intent-find-match.ts', 'exact-name short-circuit non-fatal', /if \(!exactPersonMatch\) \{\s+void shadowMatchRerank\([\s\S]+?\)\.catch\(\(\) => undefined\);/);
    after('src/services/recommendation-engine/recommendation-generator.ts', 'recommendations = rankedOrder', /void shadowSuggestionPick\([\s\S]+?\)\.catch\(\(\) => undefined\);/);
    after('src/services/notification-service.ts', 'sendPushToUser(userId, tenantId, payload, supabase)', /void shadowNotificationWorth\([\s\S]+?\)\.catch\(\(\) => undefined\);\s+return \{ pushed, inapp: inappWritten \};/);
    after('src/routes/discover-feed.ts', 'const ranked = rankFeedProducts(', /void shadowFeedPick\([\s\S]+?\)\.catch\(\(\) => undefined\);/);
    const ranker = src('src/services/voice-tools/community-member-ranker.ts');
    expect(ranker).toMatch(/void shadowMemberTiebreak\([\s\S]+?\)\.catch\(\(\) => undefined\);/);
    // Only on the two hash-pick fallbacks (location-only and floor), never on a signal-based winner.
    expect(ranker.match(/fireMemberTiebreakShadow\(args, pool, /g)).toHaveLength(2);
    expect(ranker).toMatch(/const floorCand = pickByQueryHash\(pool, args\.query\);\s+fireMemberTiebreakShadow\(/);
  });

  test('the shadow modes and sample rates are pinned on staging only; nothing opens the member plane', () => {
    const stage = readFileSync(join(__dirname, '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    const prod = readFileSync(join(__dirname, '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    for (const g of ['CALENDAR_PRIORITY', 'NEXT_ACTION', 'MATCH_RERANK', 'SUGGESTION_PICK', 'NOTIFICATION_WORTH', 'FEED_PICK', 'MEMBER_TIEBREAK']) {
      expect(stage).toContain(`{name:"JEV_COMMUNITY_${g}_MODE", value:"shadow"}`);
      expect(prod).not.toContain(`JEV_COMMUNITY_${g}_`);
    }
    expect(stage).toContain('{name:"JEV_COMMUNITY_NOTIFICATION_WORTH_SAMPLE", value:"0.1"}');
    expect(stage).toContain('{name:"JEV_COMMUNITY_FEED_PICK_SAMPLE", value:"0.1"}');
    expect(stage).not.toMatch(/JEV_COMMUNITY_ENABLED", value:"true"/);
    expect(prod).not.toMatch(/JEV_COMMUNITY_ENABLED", value:"true"/);
  });

  test('the Jev pin step stays under GitHub\'s 20,000-character run limit', () => {
    const stage = readFileSync(join(__dirname, '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    const start = stage.indexOf('- name: Resolve Jev decision config');
    expect(start).toBeGreaterThan(-1);
    const next = stage.indexOf('\n      - name:', start + 10);
    const step = stage.slice(start, next === -1 ? undefined : next);
    const run = step.slice(step.indexOf('run: |'));
    expect(run.length).toBeLessThan(20000);
  });
});
