/**
 * VTID-04414 (Plan v1 WS-1.3) — one context builder for every ORB voice path.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  LESSON_LEARNER_HEADER,
  LESSON_LEARNER_MAX_CHARS,
  LESSON_PERSONA,
  buildBaseSessionContext,
  buildLessonContext,
  buildLessonLearnerBlock,
  composeSessionContext,
  rebuildSessionContext,
  resolveBrainRole,
} from '../../../../src/orb/live/session/session-context-builder';
import { packBootstrapContext, splitBootstrapSections } from '../../../../src/orb/live/instruction/bootstrap-packer';

const identity = { user_id: 'u-1', tenant_id: 't-1', email: 'x@example.com' } as any;

const SNAPSHOT = [
  '=== IDENTITY LOCK ===',
  'You are Vitana.',
  '',
  '## Verified Facts About This User',
  'The following are extracted, structured facts (high confidence):',
  '- user_name: Ana',
  '- favourite_activity: morning walks',
  '',
  '=== ACTIVE LIFE COMPASS GOAL (apply to every recommendation this turn) ===',
  'Primary goal: "sleep better"',
  'NON-NEGOTIABLE: every suggestion ...',
].join('\n');

function legacyFn(text = 'LEGACY PACK') {
  return jest.fn(async () => ({ contextInstruction: text, latencyMs: 5 }));
}

describe('resolveBrainRole', () => {
  it('mobile is always community', () => {
    expect(resolveBrainRole({ isMobile: true, route: '/command-hub', identityRole: 'admin' })).toBe('community');
  });
  it('the Command Hub is developer', () => {
    expect(resolveBrainRole({ route: '/command-hub/x', identityRole: 'community' })).toBe('developer');
  });
  it('otherwise the identity role, defaulting to community', () => {
    expect(resolveBrainRole({ identityRole: 'professional' })).toBe('professional');
    expect(resolveBrainRole({})).toBe('community');
  });
});

describe('buildBaseSessionContext', () => {
  it('uses the brain when enabled and returns the core instruction', async () => {
    const legacy = legacyFn();
    const buildBrain = jest.fn(async () => ({ instruction: 'BRAIN FULL', contextPack: {} as any, coreInstruction: 'BRAIN CORE' }));
    const r = await buildBaseSessionContext(
      { identity, sessionId: 's1', brainRole: 'community', timezone: 'Europe/Berlin', useBrain: true },
      { legacy, buildBrain },
    );
    expect(r.builder).toBe('brain');
    expect(r.contextInstruction).toBe('BRAIN FULL');
    expect(r.coreInstruction).toBe('BRAIN CORE');
    expect(legacy).not.toHaveBeenCalled();
    expect(buildBrain).toHaveBeenCalledWith({
      user_id: 'u-1', tenant_id: 't-1', role: 'community', channel: 'orb', thread_id: 's1', user_timezone: 'Europe/Berlin',
    });
  });

  it('uses the legacy pack when the brain is off', async () => {
    const legacy = legacyFn();
    const buildBrain = jest.fn();
    const r = await buildBaseSessionContext({ identity, sessionId: 's1', brainRole: 'community', useBrain: false }, { legacy, buildBrain: buildBrain as any });
    expect(r.builder).toBe('legacy');
    expect(r.contextInstruction).toBe('LEGACY PACK');
    expect(buildBrain).not.toHaveBeenCalled();
  });

  it('reads the flag when the caller did not pass it', async () => {
    const r = await buildBaseSessionContext(
      { identity, sessionId: 's1', brainRole: 'community' },
      { legacy: legacyFn(), isBrainEnabled: async () => true, buildBrain: async () => ({ instruction: 'B', contextPack: {} as any, coreInstruction: 'B' }) },
    );
    expect(r.builder).toBe('brain');
  });

  it('falls back to the legacy pack on a brain failure and names it', async () => {
    const r = await buildBaseSessionContext(
      { identity, sessionId: 's1', brainRole: 'community', useBrain: true },
      { legacy: legacyFn(), buildBrain: async () => { throw new Error('boom'); } },
    );
    expect(r.builder).toBe('legacy');
    expect(r.contextInstruction).toBe('LEGACY PACK');
    expect(r.brainError).toBe('boom');
  });
});

describe('composeSessionContext', () => {
  // The pre-VTID-04414 inline composition from live-session-controller.ts.
  function oldCompose(base: string, role: string, isAdmin: boolean, offer: string, briefing: string, journey: string) {
    let finalContext = base || '';
    if (role === 'community' && offer) finalContext = finalContext ? `${finalContext}\n\n${offer}` : offer;
    if (isAdmin && briefing) finalContext = finalContext ? `${finalContext}\n\n${briefing}` : briefing;
    if (journey) finalContext = finalContext ? `${finalContext}${journey}` : journey.trimStart();
    return finalContext;
  }

  const cases: Array<[string, string, boolean, string, string, string]> = [
    ['BASE', 'community', false, 'OFFER', 'BRIEF', '\n\nJOURNEY'],
    ['BASE', 'admin', true, 'OFFER', 'BRIEF', '\n\nJOURNEY'],
    ['', 'community', false, 'OFFER', '', ''],
    ['', 'admin', true, '', 'BRIEF', '\n\nJOURNEY'],
    ['', 'community', false, '', '', '\n\nJOURNEY'],
    ['BASE', 'professional', false, 'OFFER', 'BRIEF', ''],
  ];

  it.each(cases)('is byte-identical to the old inline composition (%s / %s)', (base, role, isAdmin, offer, briefing, journey) => {
    const r = composeSessionContext({
      base, role, isAdminRole: isAdmin, extras: { autopilotOffer: offer, adminBriefing: briefing }, journeyBlock: journey,
    });
    expect(r.text).toBe(oldCompose(base, role, isAdmin, offer, briefing, journey));
  });

  it('reports which extras applied', () => {
    const r = composeSessionContext({ base: 'B', role: 'community', isAdminRole: false, extras: { autopilotOffer: 'O', adminBriefing: 'X' }, journeyBlock: '' });
    expect(r.applied).toEqual({ autopilotOffer: true, adminBriefing: false, journey: false });
  });
});

describe('lesson surface', () => {
  it('extracts only the verified facts, under a background header', () => {
    const block = buildLessonLearnerBlock(SNAPSHOT);
    expect(block.startsWith(LESSON_LEARNER_HEADER)).toBe(true);
    expect(block).toContain('- user_name: Ana');
    expect(block).toContain('- favourite_activity: morning walks');
    expect(block).not.toContain('NON-NEGOTIABLE');
    expect(block).not.toContain('IDENTITY LOCK');
  });

  it('returns empty without a snapshot or without facts', () => {
    expect(buildLessonLearnerBlock(null)).toBe('');
    expect(buildLessonLearnerBlock('=== IDENTITY LOCK ===\nYou are Vitana.')).toBe('');
  });

  it('bounds the facts at a line boundary', () => {
    const many = ['## Verified Facts About This User', ...Array.from({ length: 200 }, (_, i) => `- fact_${i}: ${'x'.repeat(40)}`)].join('\n');
    const block = buildLessonLearnerBlock(many);
    const factLines = block.split('\n').filter((l) => l.startsWith('- '));
    expect(factLines.length).toBeGreaterThan(0);
    expect(factLines.join('\n').length).toBeLessThanOrEqual(LESSON_LEARNER_MAX_CHARS);
    for (const l of factLines) expect(l).toMatch(/^- fact_\d+: x{40}$/);
  });

  it('is pinned by the bootstrap packer (never dropped for budget)', () => {
    const section = splitBootstrapSections(`${LESSON_LEARNER_HEADER}\n- a: b\n`)[0];
    expect(section.key).toBe('learner_background');
    expect(section.priority).toBe(1);
  });

  it('builds persona + journey + learner, reading both in parallel', async () => {
    const r = await buildLessonContext(
      { userId: 'u-1', tenantId: 't-1', lang: 'de' },
      { fetchJourneyBlock: async () => '\n\nJOURNEY', readSnapshotInstruction: async () => SNAPSHOT },
    );
    expect(r.text.startsWith(LESSON_PERSONA)).toBe(true);
    expect(r.text).toContain('\n\nJOURNEY');
    expect(r.text).toContain(LESSON_LEARNER_HEADER);
    expect(r.journey).toBe(true);
    expect(r.learnerChars).toBeGreaterThan(0);
  });

  it('never waits past the snapshot bound', async () => {
    const start = Date.now();
    const r = await buildLessonContext(
      { userId: 'u-1', tenantId: 't-1', lang: 'en' },
      { fetchJourneyBlock: async () => '', readSnapshotInstruction: () => new Promise(() => {}), snapshotWaitMs: 40 },
    );
    expect(Date.now() - start).toBeLessThan(500);
    expect(r.text).toBe(LESSON_PERSONA);
  });

  it('fails open to the persona on read errors', async () => {
    const r = await buildLessonContext(
      { userId: 'u-1', tenantId: 't-1', lang: 'en' },
      { fetchJourneyBlock: async () => { throw new Error('x'); }, readSnapshotInstruction: async () => { throw new Error('y'); } },
    );
    expect(r.text).toBe(LESSON_PERSONA);
  });

  it('respects the kill switch', async () => {
    const prev = process.env.BRAIN_LESSON_CONTEXT;
    process.env.BRAIN_LESSON_CONTEXT = 'false';
    try {
      const read = jest.fn(async () => SNAPSHOT);
      const r = await buildLessonContext({ userId: 'u-1', tenantId: 't-1', lang: 'en' }, { fetchJourneyBlock: async () => '', readSnapshotInstruction: read });
      expect(read).not.toHaveBeenCalled();
      expect(r.learnerChars).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.BRAIN_LESSON_CONTEXT; else process.env.BRAIN_LESSON_CONTEXT = prev;
    }
  });
});

describe('rebuildSessionContext (reconnect)', () => {
  const isAdminRole = (r: string | null | undefined) => r === 'admin';

  it('rebuilds a brain session with the brain, its role and its extras', async () => {
    const buildBrain = jest.fn(async () => ({ instruction: 'BRAIN', contextPack: {} as any, coreInstruction: 'BRAIN' }));
    const legacy = legacyFn();
    const r = await rebuildSessionContext(
      {
        identity, lang: 'de', active_role: 'community', clientContext: { timezone: 'Europe/Berlin' },
        contextBuilder: 'brain', contextBrainRole: 'community', contextExtras: { autopilotOffer: 'OFFER' },
      },
      's1',
      { legacy, buildBrain, isAdminRole, fetchJourneyBlock: async () => '\n\nJOURNEY' },
    );
    expect(r?.builder).toBe('brain');
    expect(r?.contextInstruction).toBe('BRAIN\n\nOFFER\n\nJOURNEY');
    expect(legacy).not.toHaveBeenCalled();
    expect(buildBrain).toHaveBeenCalledWith(expect.objectContaining({ role: 'community', user_timezone: 'Europe/Berlin' }));
  });

  it('rebuilds a lesson with the lesson surface, never the community pack', async () => {
    const legacy = legacyFn();
    const buildBrain = jest.fn();
    const r = await rebuildSessionContext(
      { identity, lang: 'en', contextBuilder: 'lesson' },
      's1',
      { legacy, buildBrain: buildBrain as any, isAdminRole, lesson: { fetchJourneyBlock: async () => '', readSnapshotInstruction: async () => null } },
    );
    expect(r?.builder).toBe('lesson');
    expect(r?.contextInstruction).toBe(LESSON_PERSONA);
    expect(legacy).not.toHaveBeenCalled();
    expect(buildBrain).not.toHaveBeenCalled();
  });

  it('keeps the legacy rebuild for a session with no recorded builder', async () => {
    const buildBrain = jest.fn();
    const r = await rebuildSessionContext(
      { identity, lang: 'en', active_role: 'community' },
      's1',
      { legacy: legacyFn('L'), buildBrain: buildBrain as any, isAdminRole, fetchJourneyBlock: async () => '' },
    );
    expect(r?.builder).toBe('legacy');
    expect(r?.contextInstruction).toBe('L');
    expect(buildBrain).not.toHaveBeenCalled();
  });

  it('re-applies the admin briefing for an admin session', async () => {
    const r = await rebuildSessionContext(
      { identity, lang: 'en', active_role: 'admin', contextBuilder: 'legacy', contextExtras: { adminBriefing: 'BRIEF', autopilotOffer: 'OFFER' } },
      's1',
      { legacy: legacyFn('L'), isAdminRole, fetchJourneyBlock: async () => '' },
    );
    expect(r?.contextInstruction).toBe('L\n\nBRIEF');
  });

  it('returns null without an identity or when the build is empty', async () => {
    expect(await rebuildSessionContext({ lang: 'en' }, 's1', { legacy: legacyFn(), isAdminRole })).toBeNull();
    expect(await rebuildSessionContext({ identity, lang: 'en', contextBuilder: 'legacy' }, 's1', { legacy: legacyFn(''), isAdminRole, fetchJourneyBlock: async () => '' })).toBeNull();
  });
});

describe('source contracts — every voice path uses the shared builder', () => {
  const root = join(__dirname, '../../../../src');
  const controller = readFileSync(join(root, 'orb/live/session/live-session-controller.ts'), 'utf8');
  const orbLive = readFileSync(join(root, 'routes/orb-live.ts'), 'utf8');
  const livekit = readFileSync(join(root, 'routes/orb-livekit.ts'), 'utf8');

  it('session start builds through buildBaseSessionContext and records the builder', () => {
    expect(controller).toMatch(/buildBaseSessionContext\(/);
    expect(controller).toMatch(/composeSessionContext\(/);
    expect(controller).toMatch(/session\.contextBuilder\s*=/);
    expect(controller).toMatch(/session\.contextBrainRole\s*=\s*brainRole/);
    expect(controller).toMatch(/session\.contextExtras\s*=\s*contextExtras/);
    // The inline brain call is gone from the controller.
    expect(controller).not.toMatch(/buildBrainSystemInstructionCached\(/);
  });

  it('the guided-topic path uses the lesson surface', () => {
    expect(controller).toMatch(/buildLessonContext\(\{ userId: guidedTopicUserId/);
    expect(controller).toMatch(/session\.contextBuilder = 'lesson'/);
  });

  it('the SSE reconnect rebuild uses rebuildSessionContext, not the bare legacy pack', () => {
    const i = orbLive.indexOf('Reconnect detected for ${sessionId}');
    expect(i).toBeGreaterThan(0);
    const block = orbLive.slice(i, i + 2500);
    expect(block).toMatch(/rebuildSessionContext\(session, sessionId/);
    expect(block).not.toMatch(/await buildBootstrapContextPack\(session\.identity/);
    expect(block).toMatch(/emitDiag\(session, 'context_rebuilt_on_reconnect'/);
  });

  it('LiveKit uses the shared builder and packs the brain text to the bootstrap budget', () => {
    expect(livekit).toMatch(/buildBaseSessionContext\(/);
    expect(livekit).toMatch(/packBootstrapContext\(base\.contextInstruction\)/);
    expect(livekit).toMatch(/builder: historyContextPack\.builder/);
  });

  it('the packed LiveKit brain text fits the budget', () => {
    const big = `=== IDENTITY LOCK ===\nYou are Vitana.\n## USER CONTEXT PROFILE\n${'x'.repeat(40_000)}`;
    expect(packBootstrapContext(big).text.length).toBeLessThanOrEqual(12_500);
  });
});
