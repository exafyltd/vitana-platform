/**
 * VTID-03252 — ENVIRONMENT block contract (context-integrity gate).
 *
 * Guards the block the assistant reads for the user's location + LOCAL TIME.
 * These contracts fail the build if a change re-breaks env context (the
 * "Berlin / 8:30 PM in Cologne" class of bug).
 */

import { formatClientContextForInstruction } from '../../../../src/orb/live/instruction/client-context-format';
import type { ClientContext } from '../../../../src/orb/live/types';

function ctx(over: Partial<ClientContext> = {}): ClientContext {
  return { ...over } as ClientContext;
}

describe('formatClientContextForInstruction — ENVIRONMENT block contract', () => {
  it('surfaces location + timezone + local time when all are known', () => {
    const out = formatClientContextForInstruction(
      ctx({ city: 'Cologne', country: 'Germany', timezone: 'Europe/Berlin', localTime: 'Monday afternoon, 15:44' }),
    );
    expect(out).toContain('ENVIRONMENT CONTEXT');
    expect(out).toContain('User location: Cologne, Germany');
    expect(out).toContain('Timezone: Europe/Berlin');
    expect(out).toContain('Local time: Monday afternoon, 15:44');
  });

  it('CONTRACT: always carries a UTC anchor so the model can compute any timezone', () => {
    const out = formatClientContextForInstruction(ctx({ timezone: 'Europe/Berlin' }));
    expect(out).toMatch(/Current UTC time: \d{4}-\d{2}-\d{2}T/);
  });

  it('CONTRACT: NEVER fabricates a city/location when geo is unavailable', () => {
    // geo-IP failed → no city/country. The block must NOT invent a location.
    const out = formatClientContextForInstruction(ctx({ timezone: 'Europe/Berlin', localTime: 'Monday afternoon, 15:44' }));
    expect(out).not.toContain('User location:');
    // ...but local time (from the browser TZ) is still present — time integrity.
    expect(out).toContain('Local time: Monday afternoon, 15:44');
    expect(out).toContain('Timezone: Europe/Berlin');
  });

  it('CONTRACT: when even the timezone is unknown, omits Timezone/Local time (no guessing) but keeps the UTC anchor', () => {
    const out = formatClientContextForInstruction(ctx({}));
    expect(out).not.toContain('Timezone:');
    expect(out).not.toContain('Local time:');
    expect(out).toContain('Current UTC time:');
  });

  it('country-only location renders without a city', () => {
    const out = formatClientContextForInstruction(ctx({ country: 'Germany' }));
    expect(out).toContain('User location: Germany');
  });

  it('instructs the model to compute time from UTC, never guess offsets (DST safety)', () => {
    const out = formatClientContextForInstruction(ctx({ timezone: 'Europe/Berlin' }));
    expect(out.toLowerCase()).toContain('calculate from the utc time');
    expect(out.toLowerCase()).toContain('do not guess');
  });
});
