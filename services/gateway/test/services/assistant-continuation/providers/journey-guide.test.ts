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
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: NEXT_STEP });
    mockGetStepDef.mockReturnValue(STEP_DEF);
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx());
    expect(r.status).toBe('returned');
    const c = (r as any).candidate;
    expect(c.priority).toBe(91);
    expect(c.surface).toBe('orb_wake');
    expect(c.kind).toBe('wake_brief');
    // The spoken opener IS the step's directive — never "what do you want?".
    expect(c.userFacingLine).toBe(STEP_DEF.execute_prompt);
    expect(c.userFacingLine).not.toMatch(/what (do|can) you/i);
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

  it('priority beats new_day_return (90) and Teacher (85)', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: NEXT_STEP });
    mockGetStepDef.mockReturnValue(STEP_DEF);
    const p = makeJourneyGuideProvider();
    const r = await p.produce(makeCtx());
    expect((r as any).candidate.priority).toBeGreaterThan(90);
    expect((r as any).candidate.priority).toBeGreaterThan(85);
  });

  it('suppresses when the step has no definition (defensive)', async () => {
    mockBuildSnapshot.mockResolvedValue({ graduated: false, current_next_step: NEXT_STEP });
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
  };

  it('English block leads, forbids "what do you want", demands verify-on-claim', () => {
    const block = buildJourneyGuideBlock(guide, 'en');
    expect(block).toMatch(/GUIDE MODE/);
    expect(block).toMatch(/you LEAD/);
    expect(block).toMatch(/Set your Life Compass/);
    expect(block).toMatch(/NEVER ask/i);
    expect(block).toMatch(/TRUST by VERIFYING/);
    expect(block).toMatch(/let's do it together/i);
  });

  it('German block renders for de lang', () => {
    const block = buildJourneyGuideBlock(guide, 'de');
    expect(block).toMatch(/GUIDE-MODUS/);
    expect(block).toMatch(/du FÜHRST/);
    expect(block).toMatch(/NIEMALS/);
  });
});
