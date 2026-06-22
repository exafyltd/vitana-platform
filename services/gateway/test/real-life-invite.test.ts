/**
 * Real-Life Invite engine (advice #4) — pure tests.
 */
import {
  pickInviteActivity,
  buildInviteProposal,
} from '../src/services/guide/real-life-invite';

const PASSIVE = /(möchtest du|willst du|was möchtest|what would you like|how can i help|what can i do)/i;

describe('pickInviteActivity', () => {
  it('maps each pillar to its natural shared activity', () => {
    expect(pickInviteActivity({ strongestPillar: 'exercise', dateKey: '2026-06-18' }).activity.key).toBe('walk');
    expect(pickInviteActivity({ strongestPillar: 'nutrition', dateKey: '2026-06-18' }).activity.key).toBe('cook');
    expect(pickInviteActivity({ strongestPillar: 'mental', dateKey: '2026-06-18' }).activity.key).toBe('coffee_talk');
    expect(pickInviteActivity({ strongestPillar: 'sleep', dateKey: '2026-06-18' }).activity.key).toBe('evening_walk');
    expect(pickInviteActivity({ strongestPillar: 'hydration', dateKey: '2026-06-18' }).activity.key).toBe('walk');
  });

  it('falls back to a walk when no pillar is known', () => {
    expect(pickInviteActivity({ strongestPillar: null, dateKey: '2026-06-18' }).activity.key).toBe('walk');
  });

  it('produces a once-per-day dedupe key', () => {
    const f = pickInviteActivity({ strongestPillar: 'mental', dateKey: '2026-06-18' });
    expect(f.nudgeKey).toBe('real_life_invite:2026-06-18:coffee_talk');
  });
});

describe('buildInviteProposal', () => {
  it('proposes inviting someone to the concrete activity and offers to help (DE)', () => {
    const line = buildInviteProposal('de', pickInviteActivity({ strongestPillar: 'exercise', dateKey: '2026-06-18' }));
    expect(line).toContain('lass uns jemanden einladen');
    expect(line).toContain('einen Spaziergang zu machen');
    expect(line).toContain('Ich helfe dir');
  });

  it('proposes inviting someone (EN)', () => {
    const line = buildInviteProposal('en', pickInviteActivity({ strongestPillar: 'nutrition', dateKey: '2026-06-18' }));
    expect(line).toContain("let's invite someone");
    expect(line).toContain('to cook something healthy');
    expect(line).toContain("I'll help you send the invite");
  });

  it('NEVER contains a passive RULE 0 question, any pillar / language', () => {
    for (const lang of ['de', 'en'] as const) {
      for (const p of ['exercise', 'nutrition', 'mental', 'sleep', 'hydration', null] as const) {
        const line = buildInviteProposal(lang, pickInviteActivity({ strongestPillar: p, dateKey: '2026-06-18' }));
        expect(line).not.toMatch(PASSIVE);
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });
});
