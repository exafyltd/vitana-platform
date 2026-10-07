/**
 * VTID-04892 — the presence pacer and the onboarding journey's surface.
 *
 * 1. The TypeScript ProactiveSurface union and the database CHECK on
 *    user_proactive_touches.surface must list the same surfaces. They had
 *    drifted (the CHECK knew 7 of the code's 11), so touches on the newer
 *    surfaces were rejected and never counted toward the daily cap. This pins
 *    the latest migration that (re)defines the CHECK to the union, both ways.
 * 2. The new `onboarding_coach` surface behaves like every other surface:
 *    once per day, and it counts toward the member's cross-surface daily cap.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockTouches = jest.fn();
const mockPref = jest.fn();
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../src/services/guide/pause-check', () => ({ isPaused: jest.fn(async () => ({ paused: false })) }));
jest.mock('../src/services/guide/guide-telemetry', () => ({ emitGuideTelemetry: jest.fn() }));
jest.mock('../src/services/guide/presence-pacer-repository', () => ({
  fetchTodaysTouches: (...a: unknown[]) => mockTouches(...a),
  fetchPresencePreference: (...a: unknown[]) => mockPref(...a),
  insertProactiveTouch: jest.fn(async () => ({ error: null })),
  fetchUnresolvedTouch: jest.fn(),
  updateTouchResolution: jest.fn(),
}));

import { canSurfaceProactively } from '../src/services/guide/presence-pacer';

const ROOT = path.join(__dirname, '../../..');

function unionSurfaces(): string[] {
  const src = fs.readFileSync(path.join(__dirname, '../src/services/guide/presence-pacer.ts'), 'utf8');
  // Strip line comments first: one of them contains a ';' that would end the union early.
  const block = src.split('export type ProactiveSurface =')[1].replace(/\/\/.*$/gm, '').split(';')[0];
  return [...block.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();
}

function latestCheckSurfaces(): { file: string; surfaces: string[] } {
  const dir = path.join(ROOT, 'supabase/migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files.reverse()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = sql.match(/ADD CONSTRAINT user_proactive_touches_surface_check CHECK \(surface IN \(([\s\S]*?)\)\)/);
    if (m) return { file: f, surfaces: [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort() };
  }
  throw new Error('no migration defines user_proactive_touches_surface_check');
}

describe('VTID-04892: pacer surfaces — code and database agree', () => {
  it('the latest CHECK lists exactly the ProactiveSurface union', () => {
    const { file, surfaces } = latestCheckSurfaces();
    expect({ file, surfaces }).toEqual({ file, surfaces: unionSurfaces() });
    expect(surfaces).toContain('onboarding_coach');
  });
});

describe('VTID-04892: the onboarding journey surface in the pacer', () => {
  beforeEach(() => {
    mockTouches.mockReset();
    mockPref.mockReset();
    mockPref.mockResolvedValue({ data: [{ metadata: { level: 'quiet' } }] }); // cap 1
  });

  it('allows the first onboarding touch of the day', async () => {
    mockTouches.mockResolvedValue({ data: [] });
    expect(await canSurfaceProactively('u1', 'onboarding_coach')).toMatchObject({ allow: true, reason: 'ok' });
  });

  it('only once per day on its own surface', async () => {
    mockTouches.mockResolvedValue({ data: [{ surface: 'onboarding_coach', dismissed_at: null, sent_at: new Date().toISOString() }] });
    expect(await canSurfaceProactively('u1', 'onboarding_coach')).toMatchObject({ allow: false, reason: 'surface_already_touched_today' });
  });

  it("another surface's touch uses a quiet member's only slot (cross-surface cap)", async () => {
    mockTouches.mockResolvedValue({ data: [{ surface: 'did_you_know_card', dismissed_at: null, sent_at: new Date().toISOString() }] });
    expect(await canSurfaceProactively('u1', 'onboarding_coach')).toMatchObject({ allow: false, reason: 'daily_cap_reached' });
  });
});
