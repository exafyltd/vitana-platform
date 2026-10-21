/**
 * VTID-04879: community Class A decisions in shadow (C1 intent, C3 marketplace
 * intent, C10 worth remembering, C19 ticket triage). Jev calls are injected;
 * the shadow table, OASIS and Supabase are fakes.
 */
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn(async () => ({ ok: true })) }));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => null }));

import { readFileSync } from 'fs';
import { join } from 'path';
import { getJevDecision } from '../src/services/jev/jev-decisions';
import { createMemoryJevControl } from '../src/services/jev/jev-tenant-control';
import {
  COMMUNITY_CLASS_A_GATES,
  isCommunityGateOn,
  shadowIntentKind,
  shadowMarketplaceIntent,
  shadowTicketTriage,
  shadowWorthRemembering,
  subjectRef,
} from '../src/services/jev/gates/community-class-a-gates';
import type { JevCallResult } from '../src/services/jev/jev-client';

const TENANT = 't1';
const MEMBER = '11111111-2222-4333-8444-555555555555';
const FLAG = { enabled: true, planes: ['internal', 'system_autopilot', 'member'], monthly_budget_usd: 50 };
const ON = {
  JEV_DECISIONS_ENABLED: 'true',
  TYPESAFE_API_KEY: 'k',
  JEV_COMMUNITY_ENABLED: 'true',
  JEV_COMMUNITY_INTENT_KIND_MODE: 'shadow',
  JEV_COMMUNITY_MARKETPLACE_INTENT_MODE: 'shadow',
  JEV_COMMUNITY_WORTH_REMEMBERING_MODE: 'shadow',
  JEV_COMMUNITY_TICKET_TRIAGE_MODE: 'shadow',
} as NodeJS.ProcessEnv;

const choice = (q: string, c: string, p = 0.9) => ({ [q]: { type: 'choice', choice: c, probabilities: { [c]: p }, confidence: p } });
const ok = (answers: any): JevCallResult => ({ ok: true, model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 2 }, latency_ms: 5, attempts: 1 });

function deps(answers: any, env: NodeJS.ProcessEnv = ON) {
  const rows: any[] = [];
  const outcomes: any[] = [];
  const call = jest.fn().mockResolvedValue(ok(answers));
  return {
    rows,
    outcomes,
    call,
    d: {
      env,
      decideOptions: { call, control: createMemoryJevControl({ [TENANT]: FLAG }).control, communityRate: { admit: () => true } },
      record: jest.fn(async (r: any) => {
        rows.push(r);
        return `row-${rows.length}`;
      }),
      recordOutcome: jest.fn(async (id: string, outcome: string, agreed: boolean | null) => {
        outcomes.push({ id, outcome, agreed });
        return true;
      }),
    },
  };
}

describe('VTID-04879 decisions', () => {
  test('all four are member-content Class A decisions on the internal/autopilot planes, PII redacted', () => {
    for (const n of ['community_intent_kind', 'community_marketplace_intent', 'community_worth_remembering', 'community_ticket_triage']) {
      const d = getJevDecision(n)!;
      expect(d).toMatchObject({ data: 'member_content', community_class: 'A', pii: 'redact' });
      expect([...d.planes]).toEqual(['internal', 'system_autopilot']);
      expect(d.safety).toBeUndefined();
    }
  });

  test('labels match the existing logic exactly', () => {
    const q = (n: string, k: string) => Object.keys((getJevDecision(n)!.questions as any)[k].criteria).sort();
    expect(q('community_intent_kind', 'kind')).toEqual(
      ['activity_seek', 'commercial_buy', 'commercial_sell', 'learning_seek', 'mentor_seek', 'mutual_aid', 'none', 'partner_seek', 'social_seek'],
    );
    expect(q('community_marketplace_intent', 'intent')).toEqual(['combination', 'diagnostic_test', 'practitioner', 'product', 'service']);
    expect(q('community_ticket_triage', 'route')).toEqual(['answer_inline', 'file_ticket']);
    expect(q('community_ticket_triage', 'kind')).toEqual(['account_issue', 'bug', 'marketplace_claim', 'support_question']);
    expect((getJevDecision('community_worth_remembering')!.questions as any).worth.type).toBe('noul');
  });
});

describe('VTID-04879 gates skip unless shadow + community + tenant', () => {
  test('mode off, community off, or no tenant: no Jev call, no row', async () => {
    for (const env of [{ ...ON, JEV_COMMUNITY_INTENT_KIND_MODE: 'off' }, { ...ON, JEV_COMMUNITY_ENABLED: 'false' }]) {
      const t = deps(choice('kind', 'commercial_buy'), env as any);
      expect(await shadowIntentKind({ utterance: 'I want to sell my bike', existingKind: 'commercial_sell', existingConfidence: 0.9, tenantId: TENANT, source: 'x' }, t.d)).toBeNull();
      expect(t.call).not.toHaveBeenCalled();
      expect(t.rows).toEqual([]);
    }
    const t = deps(choice('kind', 'commercial_buy'));
    expect(await shadowIntentKind({ utterance: 'x y z', existingKind: null, existingConfidence: 0, tenantId: null, source: 'x' }, t.d)).toBeNull();
    expect(t.call).not.toHaveBeenCalled();
  });

  test('the gate helper reads mode and community together', () => {
    expect(COMMUNITY_CLASS_A_GATES).toHaveLength(4);
    expect(isCommunityGateOn('community_intent_kind', ON)).toBe(true);
    expect(isCommunityGateOn('community_intent_kind', { ...ON, JEV_COMMUNITY_ENABLED: undefined } as any)).toBe(false);
    expect(isCommunityGateOn('community_intent_kind', { ...ON, JEV_COMMUNITY_INTENT_KIND_MODE: undefined } as any)).toBe(false);
  });
});

describe('VTID-04879 C1 intent kind', () => {
  test('records agreement with the classifier, member plane, no text in the row', async () => {
    const t = deps(choice('kind', 'commercial_sell'));
    const id = await shadowIntentKind(
      { utterance: 'I want to sell my old road bike', existingKind: 'commercial_sell', existingConfidence: 0.91, tenantId: TENANT, userId: MEMBER, sessionId: 's1', source: 'post_intent' },
      t.d,
    );
    expect(id).toBe('row-1');
    const row = t.rows[0];
    expect(row).toMatchObject({ gate: 'community_intent_kind', mode: 'shadow', plane: 'member', tenant_id: TENANT, subject_type: 'community_utterance', agreed: true, system_action: 'existing_commercial_sell' });
    expect(JSON.stringify(row)).not.toContain('road bike');
    expect(JSON.stringify(row)).not.toContain(MEMBER);
    expect(row.subject_ref).toBe(subjectRef('post_intent', 's1', 'I want to sell my old road bike'));
  });

  test('a classifier answer under 0.7 counts as none', async () => {
    const t = deps(choice('kind', 'none'));
    await shadowIntentKind({ utterance: 'hmm, not sure', existingKind: 'social_seek', existingConfidence: 0.4, tenantId: TENANT, source: 'find_match' }, t.d);
    expect(t.rows[0]).toMatchObject({ agreed: true, system_action: 'existing_none' });
  });

  test('the call runs as a system_autopilot caller and counts as member spend', async () => {
    const t = deps(choice('kind', 'commercial_buy'));
    const control = createMemoryJevControl({ [TENANT]: FLAG });
    t.d.decideOptions.control = control.control;
    await shadowIntentKind({ utterance: 'I need running shoes', existingKind: 'commercial_buy', existingConfidence: 0.9, tenantId: TENANT, source: 'x' }, t.d);
    expect(control.records).toEqual([expect.objectContaining({ tenantId: TENANT, plane: 'member' })]);
  });

  test('a tenant without the member plane is denied by policy: a fallback row, no spend', async () => {
    const t = deps(choice('kind', 'commercial_buy'));
    const control = createMemoryJevControl({ [TENANT]: { enabled: true, planes: ['internal'], monthly_budget_usd: null } });
    t.d.decideOptions.control = control.control;
    await shadowIntentKind({ utterance: 'I need running shoes', existingKind: 'commercial_buy', existingConfidence: 0.9, tenantId: TENANT, source: 'x' }, t.d);
    expect(t.call).not.toHaveBeenCalled();
    expect(t.rows[0]).toMatchObject({ jev_outcome: 'denied', agreed: null });
    expect(control.records).toEqual([]);
  });
});

describe('VTID-04879 C3 marketplace intent', () => {
  test('agreement against the heuristic label', async () => {
    const t = deps(choice('intent', 'practitioner'));
    await shadowMarketplaceIntent({ need: 'a coach for my back pain', existingIntent: 'service', tenantId: TENANT }, t.d);
    expect(t.rows[0]).toMatchObject({ gate: 'community_marketplace_intent', subject_type: 'community_marketplace_need', agreed: false, system_action: 'existing_service' });
  });
});

describe('VTID-04879 C10 worth remembering', () => {
  test('no agreement at first; settled from what the extractor stored', async () => {
    const t = deps({ worth: { type: 'noul', noul: 0.9 } });
    const s = shadowWorthRemembering({ conversation: 'My daughter Mia starts school in Vienna next month.', tenantId: TENANT, userId: MEMBER, sessionId: 's2' }, t.d);
    await s.settle(2);
    expect(t.rows[0]).toMatchObject({ gate: 'community_worth_remembering', subject_type: 'community_memory_turn', agreed: null, outcome: null });
    expect(t.outcomes).toEqual([{ id: 'row-1', outcome: 'extractor_stored_facts', agreed: true }]);
    expect(JSON.stringify(t.rows[0])).not.toContain('Mia');
  });

  test('Jev says worth it, the extractor stored nothing → disagreement', async () => {
    const t = deps({ worth: { type: 'noul', noul: 0.95 } });
    await shadowWorthRemembering({ conversation: 'ok thanks, see you tomorrow then, bye bye now', tenantId: TENANT, sessionId: 's3' }, t.d).settle(0);
    expect(t.outcomes).toEqual([{ id: 'row-1', outcome: 'extractor_stored_nothing', agreed: false }]);
  });

  test('an abstention or a skipped gate settles nothing', async () => {
    const t = deps({ worth: { type: 'noul', noul: 0.55 } });
    await shadowWorthRemembering({ conversation: 'maybe, maybe not, who knows really', tenantId: TENANT, sessionId: 's4' }, t.d).settle(1);
    expect(t.outcomes).toEqual([]);
    const off = deps({ worth: { type: 'noul', noul: 0.9 } }, { ...ON, JEV_COMMUNITY_WORTH_REMEMBERING_MODE: 'off' } as any);
    await shadowWorthRemembering({ conversation: 'something long enough here', tenantId: TENANT, sessionId: 's5' }, off.d).settle(1);
    expect(off.rows).toEqual([]);
    expect(off.outcomes).toEqual([]);
  });

  test('Jev sees the most recent 2,000 characters', async () => {
    const t = deps({ worth: { type: 'noul', noul: 0.9 } });
    const long = 'a'.repeat(3000) + 'END';
    await shadowWorthRemembering({ conversation: long, tenantId: TENANT, sessionId: 's6' }, t.d).settle(1);
    const state = (t.call.mock.calls[0][0] as any).state;
    expect(state.conversation.length).toBe(2000);
    expect(state.conversation.endsWith('END')).toBe(true);
  });
});

describe('VTID-04879 C19 ticket triage', () => {
  test('answer_inline vs a filed ticket, compared with the RPC decision', async () => {
    const t = deps({ ...choice('route', 'file_ticket'), ...choice('kind', 'bug') });
    await shadowTicketTriage({ summary: 'The diary save button does nothing', existingDecision: null, personaPicked: true, tenantId: TENANT }, t.d);
    expect(t.rows[0]).toMatchObject({ gate: 'community_ticket_triage', agreed: true, system_action: 'existing_file_ticket' });
    expect(t.rows[0].jev_verdict.answers.kind.value).toBe('bug');
    const t2 = deps({ ...choice('route', 'file_ticket'), ...choice('kind', 'support_question') });
    await shadowTicketTriage({ summary: 'How does the diary work?', existingDecision: 'answer_inline', personaPicked: false, tenantId: TENANT }, t2.d);
    expect(t2.rows[0]).toMatchObject({ agreed: false, system_action: 'existing_answer_inline' });
  });
});

describe('VTID-04879 gates never throw', () => {
  test('a failing Jev call and a failing shadow insert both resolve to null', async () => {
    const t = deps(choice('kind', 'commercial_buy'));
    t.call.mockRejectedValue(new Error('boom'));
    // A thrown Jev call is caught: either a fallback row is recorded or nothing — never a rejection.
    const r = await shadowIntentKind({ utterance: 'I need shoes', existingKind: null, existingConfidence: 0, tenantId: TENANT, source: 'x' }, t.d);
    expect(r === null || r === 'row-1').toBe(true);
    if (r) expect(t.rows[0]).toMatchObject({ agreed: null });
    const t2 = deps(choice('kind', 'commercial_buy'));
    t2.d.record = jest.fn(async () => {
      throw new Error('db down');
    });
    await expect(shadowIntentKind({ utterance: 'I need shoes', existingKind: null, existingConfidence: 0, tenantId: TENANT, source: 'x' }, t2.d)).resolves.toBeNull();
    const t3 = deps({ worth: { type: 'noul', noul: 0.9 } });
    t3.d.recordOutcome = jest.fn(async () => {
      throw new Error('db down');
    });
    await expect(shadowWorthRemembering({ conversation: 'My sister lives in Graz.', tenantId: TENANT, sessionId: 's' }, t3.d).settle(1)).resolves.toBeUndefined();
  });
});

describe('VTID-04879 wiring', () => {
  const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8');

  test('every call site is fire-and-forget with its own catch', () => {
    expect(src('src/services/intent-find-match.ts')).toMatch(/void shadowIntentKind\([^;]+\)\.catch\(\(\) => undefined\);/);
    expect(src('src/routes/intents.ts')).toMatch(/void shadowIntentKind\([^;]+\)\.catch\(\(\) => undefined\);/);
    expect(src('src/routes/orb-live.ts')).toMatch(/g\.shadowIntentKind\(/);
    expect(src('src/services/orb-tools/marketplace-guide-tools.ts')).toMatch(/void shadowMarketplaceIntent\([^;]+\)\.catch\(\(\) => undefined\);/);
    expect(src('src/services/report-to-specialist-core.ts')).toMatch(/void shadowTicketTriage\([^;]+\)\.catch\(\(\) => undefined\);/);
    expect(src('src/services/extraction-dedup-manager.ts')).toMatch(/\.then\(\(r\) => memoryShadow\.settle\(r\?\.persisted \?\? 0\)\)/);
  });

  test('the shadow modes are pinned on staging only', () => {
    const stage = readFileSync(join(__dirname, '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
    const prod = readFileSync(join(__dirname, '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
    for (const g of ['INTENT_KIND', 'MARKETPLACE_INTENT', 'WORTH_REMEMBERING', 'TICKET_TRIAGE']) {
      expect(stage).toContain(`{name:"JEV_COMMUNITY_${g}_MODE", value:"shadow"}`);
      expect(prod).not.toContain(`JEV_COMMUNITY_${g}_MODE`);
    }
    // Nothing here opens the member plane.
    expect(stage).not.toMatch(/JEV_COMMUNITY_ENABLED", value:"true"/);
    expect(prod).not.toMatch(/JEV_COMMUNITY_ENABLED", value:"true"/);
  });
});

describe('VTID-04879 extractAndPersistFacts reports what it stored', () => {
  test('text too short for a fact returns { persisted: 0 } without calling the LLM', async () => {
    const { extractAndPersistFacts } = await import('../src/services/inline-fact-extractor');
    await expect(extractAndPersistFacts({ conversationText: 'hi', tenant_id: TENANT, user_id: MEMBER, session_id: 's' })).resolves.toEqual({ persisted: 0 });
  });
});
