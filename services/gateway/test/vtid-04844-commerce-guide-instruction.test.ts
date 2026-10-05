/**
 * VTID-04844 — on the commerce surface Vitana is the supplier's onboarding
 * guide and Vitanaland Commerce specialist: grounded facts, guide conduct,
 * the supplier's own setup state at session start, and never the tenant-admin
 * briefing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { WORK_SURFACE_CONDUCT_BLOCK } from '../src/orb/live/instruction/live-system-instruction';
import { COMMERCE_GUIDE_CONDUCT, COMMERCE_GUIDE_FACTS } from '../src/orb/live/instruction/commerce-guide';
import {
  loadCommerceKnowledge,
  loadCommerceOrgFacts,
  renderCommerceFacts,
  type CommerceKnowledgeDeps,
} from '../src/orb/profile/commerce-knowledge';
import { PERSONALITY_DEFAULTS } from '../src/services/ai-personality-service';
import { computeGreetingDecision, type GreetingDecisionContext } from '../src/services/conversation/compute-greeting-decision';

const FLAG = 'COMMERCE_AI_SETUP_ENABLED';

describe('the commerce instruction makes Vitana an onboarding guide', () => {
  const prev = process.env[FLAG];
  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  });

  test('commerce gets the guide conduct and the Commerce facts', () => {
    const block = WORK_SURFACE_CONDUCT_BLOCK('commerce');
    expect(block).toContain('WORK SURFACE —');
    expect(block).toContain('HOW YOU GUIDE');
    expect(block).toContain('VITANALAND COMMERCE — WHAT YOU KNOW');
    expect(block).toContain('hidden draft');
    expect(block).toContain('One step at a time');
  });

  test('the other work surfaces are unchanged by it', () => {
    for (const s of ['admin', 'backoffice', 'command-hub']) {
      const block = WORK_SURFACE_CONDUCT_BLOCK(s);
      expect(block).not.toContain('VITANALAND COMMERCE');
      expect(block).not.toContain('HOW YOU GUIDE');
    }
  });

  test('the drafting tool is offered only when AI setup is switched on', () => {
    expect(COMMERCE_GUIDE_CONDUCT({} as NodeJS.ProcessEnv)).not.toContain('draft_business_setup');
    expect(COMMERCE_GUIDE_CONDUCT({ [FLAG]: 'true' } as NodeJS.ProcessEnv)).toContain('draft_business_setup');
  });

  test('voice never commits, and undecided terms are never promised', () => {
    const conduct = COMMERCE_GUIDE_CONDUCT({ [FLAG]: 'true' } as NodeJS.ProcessEnv);
    expect(conduct).toContain('never by voice');
    expect(COMMERCE_GUIDE_FACTS).toMatch(/Still being decided, so never promise or quote them: commission rates/);
    expect(COMMERCE_GUIDE_FACTS).toContain('never depend on commission');
  });

  test('NEVER rule 41: instructions, not scripted sentences', () => {
    const all = `${COMMERCE_GUIDE_FACTS}\n${COMMERCE_GUIDE_CONDUCT({ [FLAG]: 'true' } as NodeJS.ProcessEnv)}`;
    expect(all).not.toMatch(/Say exactly|say: "|"[^"]{20,}"/i);
  });

  test('the persona names the onboarding role and lane', () => {
    const p = PERSONALITY_DEFAULTS.commerce_orb as Record<string, string>;
    expect(p.voice_base_identity).toContain('onboarding guide');
    expect(p.voice_important_section).toContain('business setup and onboarding');
  });
});

function deps(rows: Array<{ role: string; partner_organization_id: string }>, orgs: Record<string, any>, checklists: Record<string, any>) {
  const calls: Array<[string, string]> = [];
  const supabase = {
    from: (table: string) => ({
      select: () => ({
        eq: (col: string, val: string) => {
          calls.push([table, `${col}=${val}`]);
          return { limit: async () => ({ data: rows, error: null }) };
        },
      }),
    }),
  };
  const d: CommerceKnowledgeDeps = {
    supabase,
    loadOrg: async (_s, id) => ({ org: orgs[id] ?? null, error: null }),
    loadChecklist: async (_s, org) => ({ checklist: checklists[org.id] ?? null, error: null }),
  };
  return { d, calls };
}

describe("the supplier's own setup state at session start", () => {
  const ORG = { id: 'o1', display_name: 'Kräuterhaus', partner_type: 'supplier_shop', lifecycle_state: 'draft' };
  const CHECKLIST = {
    next_step: 'company',
    steps: [
      { key: 'account', required: true, status: 'done' },
      { key: 'company', required: true, status: 'in_progress', missing: ['vat_id'] },
      { key: 'verification', required: true, status: 'todo' },
      { key: 'team', required: false, status: 'todo' },
      { key: 'dpa', required: false, status: 'not_required' },
    ],
  };

  test("reads only the caller's memberships and maps the checklist", async () => {
    const { d, calls } = deps([{ role: 'org_admin', partner_organization_id: 'o1' }], { o1: ORG }, { o1: CHECKLIST });
    const facts = await loadCommerceOrgFacts('u-1', d);
    expect(calls).toEqual([['partner_organization_members', 'user_id=u-1']]);
    expect(facts).toEqual([
      {
        name: 'Kräuterhaus',
        role: 'org_admin',
        partnerType: 'supplier_shop',
        state: 'draft',
        nextStep: 'company',
        openRequired: ['company', 'verification'],
        companyMissing: ['vat_id'],
      },
    ]);
  });

  test('renders plain facts and opener highlights', async () => {
    const { d } = deps([{ role: 'org_admin', partner_organization_id: 'o1' }], { o1: ORG }, { o1: CHECKLIST });
    const k = await loadCommerceKnowledge('u-1', d);
    expect(k.systemSnapshot).toContain("YOUR SUPPLIER'S BUSINESSES");
    expect(k.systemSnapshot).toContain('Kräuterhaus (supplier shop; the user is org admin): setting up (not yet submitted).');
    expect(k.systemSnapshot).toContain('Still open: company details, verification.');
    expect(k.systemSnapshot).toContain('Company details missing: VAT ID.');
    expect(k.pulse?.highlights).toEqual(['Kräuterhaus: setting up (not yet submitted); next step company details.']);
  });

  test('a live business lists no open steps; no business says to start', () => {
    const live = renderCommerceFacts([
      { name: 'Lab A', role: 'staff', partnerType: 'lab', state: 'live', nextStep: null, openRequired: ['team'], companyMissing: [] },
    ]);
    expect(live.text).toContain('Lab A (lab; the user is staff): live.');
    expect(live.text).not.toContain('Still open');
    expect(renderCommerceFacts([]).text).toContain('no business on Vitanaland yet');
  });

  test('fails open with no database', async () => {
    expect(await loadCommerceOrgFacts('u-1', { supabase: null, loadOrg: jest.fn(), loadChecklist: jest.fn() })).toEqual([]);
  });

  test('the commerce work surface loads it, and never the tenant-admin briefing', () => {
    const ws = fs.readFileSync(path.join(__dirname, '../src/orb/profile/work-surface-context.ts'), 'utf8');
    expect(ws).toContain("if (profile.surface === 'commerce')");
    expect(ws).toContain('loadCommerceKnowledge(input.userId)');
    const ctrl = fs.readFileSync(path.join(__dirname, '../src/orb/live/session/live-session-controller.ts'), 'utf8');
    expect(ctrl).toContain("wsIdentity.tenant_id && assistantProfile.surface !== 'commerce'");
  });
});

describe('the commerce opener leads like a guide', () => {
  function ctx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
    return {
      contextReadyResolved: true, isAnonymous: false, safeFastGreetingLive: false, reconnectCount: 0,
      lang: 'de', greetLang: 'de', bucket: 'today', timeAgo: 'earlier today', wasFailure: false,
      firstName: 'Mila', hasUserId: true, hasSupabase: true, hasPriorSession: true,
      greetingNeedsOnboarding: false, greetingIsFirstTime: false, lastFullBriefingDate: null,
      todayTz: '2026-10-02', localHour: 11, timezone: 'Europe/Berlin', timeOfDay: 'morning',
      proactiveLine: null, newdayOverview: null, resumeOverview: null, rotationSeed: 1, recentNbaKeys: [],
      currentRoute: '/commerce', currentScreenTitle: null, menuPhrases: [],
      openDecision: { mode: 'speak', source: 'baseline_lead', line: null },
      guidedTopicNarrationContent: null, wakeBriefDecisionId: null, silenceOnSkipEnabled: false,
      wakeBriefHasSelectedContinuation: false, voiceWakeBriefReason: null,
      surface: 'commerce', workSurfaceRole: 'commerce',
      workSurfaceHighlights: ['Kräuterhaus: setting up (not yet submitted); next step company details.'],
      ...over,
    } as GreetingDecisionContext;
  }

  test('from where the supplier stands, one next step', () => {
    const d = computeGreetingDecision(ctx());
    expect(d.directive).toContain('onboarding guide');
    expect(d.directive).toContain('next step company details');
    expect(d.directive).not.toMatch(/Say exactly|"[^"]{20,}"/);
  });

  test('opened from the setup sheet: guide first, then the website', () => {
    const d = computeGreetingDecision(ctx({ workSurfaceTask: 'commerce_setup' }));
    expect(d.directive).toContain('as their onboarding guide');
    expect(d.directive).toContain('draft_business_setup');
  });
});
