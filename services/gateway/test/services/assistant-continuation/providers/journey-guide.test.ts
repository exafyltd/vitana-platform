/**
 * VTID-03257 (Fix-1) — journey-guide provider tests.
 *
 * Locks the product contract: for a non-graduated user, the Journey Foundation
 * checklist LEADS turn 1 — the directive step line is the spoken opener, the
 * GUIDE-MODE content is bundled, priority 91 beats new_day_return (90) and
 * Teacher (85). Suppresses once graduated, on reconnect, and when there is no
 * next step. Skips on missing inputs.
 */

import {
  makeJourneyGuideProvider,
  JOURNEY_GUIDE_PROVIDER_KEY,
  JOURNEY_GUIDE_EXTRA_KEY,
} from '../../../../src/services/assistant-continuation/providers/journey-guide';
import { validateContinuationCandidate } from '../../../../src/services/assistant-continuation/types';

// The provider reaches the journey-foundation modules via dynamic import().
const mockBuildSnapshot = jest.fn();
const mockGetStepDef = jest.fn();

jest.mock('../../../../src/services/journey-foundation/journey-foundation-state', () => ({
  buildJourneyFoundationSnapshot: (...args: any[]) => mockBuildSnapshot(...args),
}));
jest.mock('../../../../src/services/journey-foundation/foundation-steps', () => ({
  getStepDef: (...args: any[]) => mockGetStepDef(...args),
}));

const FAKE_SB = { from: () => ({}) } as any;

function makeCtx(extraOverride: any = {}) {
  return {
    surface: 'orb_wake',
    sessionId: 's1',
    userId: 'u1',
    tenantId: 't1',
    extra: {
      [JOURNEY_GUIDE_EXTRA_KEY]: {
        supabase: FAKE_SB,
        userId: 'u1',
        isReconnect: false,
        ...extraOverride,
      },
    },
  } as any;
}

const NEXT_STEP = {
  key: 'life_compass',
  title: 'Set your Life Compass',
  strand: 'health',
  type: 'action',
  tier: 0,
  status: 'pending',
  required_for_graduation: true,
  navigation_route: '/life-compass',
  benefit: 'Define the one goal your whole journey is built around.',
};

const STEP_DEF = {
  benefit: 'Define the one goal your whole journey is built around.',
  execute_prompt: "Let's set your Life Compass right now — I'll walk you through it.",
};

beforeEach(() => {
  mockBuildSnapshot.mockReset();
  mockGetStepDef.mockReset();
});

describe('VTID-03257 makeJourneyGuideProvider', () => {
  it('exposes the correct surface + key', () => {
    const p = makeJourneyGuideProvider();
    expect(p.key).toBe(JOURNEY_GUIDE_PROVIDER_KEY);
    expect(p.surfaces).toEqual(['orb_wake']);
  });

  it('skips when inputs are missing', async () => {
    const p = makeJourneyGuideProvider();
    const r = await p.produce({ surface: 'orb_wake', extra: {} } as any);
    expect(r.status).toBe('skipped');
    expect((r as any).reason).toBe('no_journey_guide_inputs');
  });

  it('suppresses on transparent reconnect', async () => {
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx({ isReconnect: true }));
    expect(r.status).toBe('suppressed');
    expect((r as any).reason).toBe('forced_skip_reconnect');
  });

  it('suppresses once the user has graduated', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: true, current_next_step: null });
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('suppressed');
    expect((r as any).reason).toBe('journey_graduated');
  });

  it('suppresses when there is no next step', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: null });
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('suppressed');
    expect((r as any).reason).toBe('no_next_step');
  });

  it('errors gracefully when the snapshot build throws', async () => {
    mockBuildSnapshot.mockRejectedValue(new Error('boom'));
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('errored');
    expect((r as any).reason).toMatch(/journey_guide_snapshot_failed/);
  });

  it('LEADS turn 1: directive opener + bundled guide, priority 91', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: NEXT_STEP, foundation_steps: [], active_goal: null, economic_intent: null });
    mockGetStepDef.mockReturnValue(STEP_DEF);
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('returned');
    const c = (r as any).candidate;
    expect(c.priority).toBe(91);
    expect(c.surface).toBe('orb_wake');
    expect(c.kind).toBe('wake_brief');
    // VTID-03266 (Fix-6): the spoken opener is a CLEAN, already-localized
    // directive line (LiveKit session.say plays it verbatim — no instruction
    // block, no marker, no structured prefix). en default here.
    expect(c.userFacingLine).toMatch(/Let's set your Life Compass together/);
    expect(c.userFacingLine).not.toContain('__VTID_03167_STRUCTURED_BLOCK__');
    expect(c.userFacingLine).not.toContain('<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>');
    // The opener LEADS — it is not an open-ended "what do you want / how can I help".
    expect(c.userFacingLine).not.toMatch(/what (do|can) you|how can i help/i);
    expect(c.dedupeKey).toBe('journey_guide:life_compass');
    // GUIDE-MODE content bundled on the candidate for the controller.
    expect(c.journeyGuide).toMatchObject({
      step_key: 'life_compass',
      step_title: 'Set your Life Compass',
      execute_prompt: STEP_DEF.execute_prompt,
      benefit: STEP_DEF.benefit,
      step_type: 'action',
      navigation_route: '/life-compass',
    });
  });

  it('VTID-03266: opener line is already in the session language (de → German, en → English)', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: NEXT_STEP, foundation_steps: [], active_goal: null, economic_intent: null });
    mockGetStepDef.mockReturnValue(STEP_DEF);
    const p = makeJourneyGuideProvider();
    // de: spoken line must BE German (LiveKit session.say does not translate).
    const de = (await p.produce(makeCtx({ lang: 'de' })) as any).candidate.userFacingLine as string;
    expect(de).toMatch(/Lass uns gemeinsam deinen Lebenskompass setzen/);
    expect(de).not.toMatch(/Let's set your Life Compass/);
    expect(de).not.toMatch(/what (do|can) you|wie kann ich (dir )?helfen/i);
    // en: English line.
    const en = (await p.produce(makeCtx({ lang: 'en' })) as any).candidate.userFacingLine as string;
    expect(en).toMatch(/Let's set your Life Compass together/);
  });

  it('VTID-03266: opener line carries NO instruction/marker text (LiveKit speaks it verbatim)', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: NEXT_STEP, foundation_steps: [], active_goal: null, economic_intent: null });
    mockGetStepDef.mockReturnValue(STEP_DEF);
    const p = makeJourneyGuideProvider();
    const line = (await p.produce(makeCtx({ lang: 'de' })) as any).candidate.userFacingLine as string;
    // None of these may appear in a string that gets spoken aloud by session.say().
    for (const forbidden of ['##', 'VERTEX_WAKE_BRIEF', '__VTID_', 'FORBIDDEN', 'OVERRIDE', 'execute_prompt']) {
      expect(line).not.toContain(forbidden);
    }
  });

  it('VTID-03268: gate beat-B — goal already set, economic stance missing → leads the MONEY beat, NOT re-asking the goal', async () => {
    mockBuildSnapshot.mockResolvedValue({
      graduated: false,
      current_next_step: NEXT_STEP, // life_compass (the gate)
      foundation_steps: [],
      active_goal: { primary_goal: 'Sleep 8h', category: 'health' }, // goal IS set
      economic_intent: null, // economy axis NOT set
    });
    mockGetStepDef.mockReturnValue(STEP_DEF);
    const p = makeJourneyGuideProvider();
    const de = (await p.produce(makeCtx({ lang: 'de' })) as any).candidate;
    expect(de.journeyGuide.opener_key).toBe('life_compass_economy');
    // German money-beat directive — does NOT re-ask the goal, does NOT ask "what do you want".
    expect(de.userFacingLine).toMatch(/Dein Ziel steht schon/);
    expect(de.userFacingLine).toMatch(/finanziell/);
    expect(de.userFacingLine).not.toMatch(/Lass uns gemeinsam deinen Lebenskompass setzen/);
    expect(de.userFacingLine).not.toMatch(/wie kann ich (dir )?helfen|was möchtest du/i);
  });

  it('VTID-03268: forward chain — upcoming step titles are bundled for the guide block', async () => {
    mockBuildSnapshot.mockResolvedValue({
      graduated: false,
      current_next_step: NEXT_STEP,
      active_goal: null,
      economic_intent: null,
      foundation_steps: [
        { key: 'life_compass', title: 'Life Compass', status: 'open' },
        { key: 'weakest_habit', title: 'Weakest habit', status: 'open' },
        { key: 'reminder', title: 'Reminder', status: 'open' },
        { key: 'diary', title: 'Diary', status: 'done' }, // satisfied → excluded
      ],
    });
    mockGetStepDef.mockReturnValue(STEP_DEF);
    const p = makeJourneyGuideProvider();
    const c = (await p.produce(makeCtx()) as any).candidate;
    expect(c.journeyGuide.upcoming_steps).toEqual(['Weakest habit', 'Reminder']);
    expect(c.journeyGuide.upcoming_steps).not.toContain('Diary'); // done excluded
    expect(c.journeyGuide.upcoming_steps).not.toContain('Life Compass'); // current excluded
  });

  it('priority beats new_day_return (90) and Teacher (85)', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: NEXT_STEP, foundation_steps: [], active_goal: null, economic_intent: null });
    mockGetStepDef.mockReturnValue(STEP_DEF);
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx());
    expect((r as any).candidate.priority).toBeGreaterThan(90);
    expect((r as any).candidate.priority).toBeGreaterThan(85);
  });

  // VTID-03264 (Fix-5 regression lock): the produced candidate MUST pass the
  // ranker's invariant validator. Fix-1 shipped with cta.type='guide_step'
  // (not in KNOWN_CTA_TYPES) so validateContinuationCandidate rejected it and
  // the provider errored on EVERY production session — Teacher led turn 1 and
  // the journey never drove the conversation. This test runs the SAME validator
  // the ranker runs, so an invalid candidate can never pass CI green again.
  it('produces a candidate that passes validateContinuationCandidate (the ranker invariant)', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: NEXT_STEP, foundation_steps: [], active_goal: null, economic_intent: null });
    mockGetStepDef.mockReturnValue(STEP_DEF);
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('returned');
    const verdict = validateContinuationCandidate((r as any).candidate);
    expect(verdict).toEqual({ ok: true });
  });

  it('suppresses when the step has no definition (defensive)', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: NEXT_STEP, foundation_steps: [], active_goal: null, economic_intent: null });
    mockGetStepDef.mockReturnValue(undefined);
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('suppressed');
    expect((r as any).reason).toBe('no_next_step');
  });
});

describe('VTID-03257 buildJourneyGuideBlock', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { buildJourneyGuideBlock } = require('../../../../src/orb/live/instruction/journey-guide-prompt');
  const guide = {
    step_key: 'life_compass',
    step_title: 'Set your Life Compass',
    execute_prompt: "Let's set your Life Compass right now.",
    benefit: 'Define the one goal your whole journey is built around.',
    step_type: 'action',
    navigation_route: '/life-compass',
    opener_key: 'life_compass',
    upcoming_steps: ['Weakest habit', 'Reminder'],
  };

  it('English block: decide-for-user, bans passive openers + "no suggestions", advances, verifies', () => {
    const block = buildJourneyGuideBlock(guide, 'en');
    expect(block).toMatch(/GUIDE MODE/);
    expect(block).toMatch(/DECIDE FOR them/);
    expect(block).toMatch(/Set your Life Compass/);
    expect(block).toMatch(/STRICTLY FORBIDDEN/);
    expect(block).toMatch(/How can I (help|support)/i);
    expect(block).toMatch(/don't have any.*suggestions/i);
    expect(block).toMatch(/ALWAYS have a concrete next step/);
    expect(block).toMatch(/TRUST by VERIFYING/);
    // forward chain present
    expect(block).toMatch(/AFTER that[\s\S]*Weakest habit, Reminder/);
    expect(block).toMatch(/move to the next/i);
  });

  it('German block: entscheidet für den Nutzer, verbietet passive Eröffnungen + "keine Vorschläge"', () => {
    const block = buildJourneyGuideBlock(guide, 'de');
    expect(block).toMatch(/GUIDE-MODUS/);
    expect(block).toMatch(/ENTSCHEIDEST FÜR sie/);
    expect(block).toMatch(/STRENG VERBOTEN/);
    expect(block).toMatch(/Wie kann ich dich unterstützen/);
    expect(block).toMatch(/keine .*Vorschläge/i);
    expect(block).toMatch(/DANACH kommen[\s\S]*Weakest habit, Reminder/);
  });
});
