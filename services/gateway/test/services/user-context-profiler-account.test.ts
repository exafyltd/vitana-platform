/**
 * VTID-03037 — user-context-profiler ACCOUNT section.
 *
 * Locks the pure renderer (`buildAccountSection`) + the wire-up that
 * places the section at the top of the profile output. The renderer is
 * load-bearing for the LiveKit / brain-OFF Vertex answer to
 * "how long have I been a member?" since these paths consume the
 * profile block via `buildBootstrapContextPack(...)`.
 *
 * Integration coverage (getUserContextSummary end-to-end) is left for a
 * separate test once the profiler suite is established — the wire-up
 * assertion below is enough to catch a regression where the fetch or
 * section insertion is silently removed.
 */

import * as fs from 'fs';
import * as path from 'path';

import { buildAccountSection, AccountRow } from '../../src/services/user-context-profiler';

const PROFILER_PATH = path.resolve(
  __dirname,
  '../../src/services/user-context-profiler.ts',
);

let profilerSource: string;

beforeAll(() => {
  profilerSource = fs.readFileSync(PROFILER_PATH, 'utf8');
});

describe('VTID-03037 buildAccountSection (pure renderer)', () => {
  const NOW = new Date('2026-05-17T10:30:00Z').getTime();

  it('returns "" when createdAt is null', () => {
    const account: AccountRow = { createdAt: null };
    expect(buildAccountSection(account, NOW)).toBe('');
  });

  it('returns "" when createdAt is an invalid Date', () => {
    const account: AccountRow = { createdAt: new Date('not-a-real-date') };
    expect(buildAccountSection(account, NOW)).toBe('');
  });

  it('renders single-day tenure with singular "day"', () => {
    const account: AccountRow = {
      createdAt: new Date('2026-05-16T10:30:00Z'),
    };
    const out = buildAccountSection(account, NOW);
    expect(out).toContain('[ACCOUNT]');
    expect(out).toContain('Joined the Vitana community on 2026-05-16.');
    expect(out).toContain('Tenure: 1 day as a community member.');
  });

  it('renders multi-day tenure with plural "days"', () => {
    const account: AccountRow = {
      createdAt: new Date('2024-12-15T10:30:00Z'),
    };
    const out = buildAccountSection(account, NOW);
    expect(out).toContain('Joined the Vitana community on 2024-12-15.');
    // Floor((2026-05-17 - 2024-12-15) / 86400_000) = 518 days.
    expect(out).toContain('Tenure: 518 days as a community member.');
  });

  it('clamps future createdAt to 0 days (clock-drift safety)', () => {
    const account: AccountRow = {
      createdAt: new Date('2026-05-20T10:30:00Z'),
    };
    const out = buildAccountSection(account, NOW);
    expect(out).toContain('Tenure: 0 days as a community member.');
    // The date line still shows the future ISO (DB is the source of
    // truth — the LLM seeing "joined on 2026-05-20" lets a human notice
    // a clock issue, rather than silently dropping the row).
    expect(out).toContain('Joined the Vitana community on 2026-05-20.');
  });

  it('renders day 0 as "0 days" (just-joined edge)', () => {
    const account: AccountRow = {
      createdAt: new Date(NOW),
    };
    const out = buildAccountSection(account, NOW);
    expect(out).toContain('Tenure: 0 days as a community member.');
  });

  it('uses a stable line order: header → joined → tenure', () => {
    const account: AccountRow = {
      createdAt: new Date('2025-11-01T00:00:00Z'),
    };
    const lines = buildAccountSection(account, NOW).split('\n');
    expect(lines[0]).toBe('[ACCOUNT]');
    expect(lines[1].startsWith('- Joined the Vitana community on ')).toBe(true);
    expect(lines[2].startsWith('- Tenure: ')).toBe(true);
  });
});

describe('VTID-03037 profiler wire-up (source-text characterization)', () => {
  it('fetches app_users.created_at via fetchAppUsersAccount', () => {
    // The fetch must live in the profiler and read created_at from
    // app_users. A regression that moves the source column (e.g. to a
    // mirror table) or drops the fetch will trip this assertion before
    // any LLM behavior change is observable.
    expect(profilerSource).toMatch(/async\s+function\s+fetchAppUsersAccount/);
    expect(profilerSource).toMatch(/from\(['"]app_users['"]\)[\s\S]{0,60}select\(['"]created_at['"]\)/);
  });

  it('runs the account fetch inside the existing parallel Promise.all batch', () => {
    // Sequential placement would tack ~30-80ms onto bootstrap latency,
    // which matters on the LiveKit click→greeting path. The batch
    // destructure must include `account` so a future refactor can’t
    // silently drop it.
    expect(profilerSource).toMatch(/const\s+\[[^\]]*account[^\]]*\]\s*=\s*await\s+Promise\.all/);
    expect(profilerSource).toMatch(/fetchAccountPromise/);
  });

  it('inserts the ACCOUNT section at the TOP of the sections list', () => {
    // Top placement is intentional — the LLM reads the tenure line
    // before activity data. The brain path positions tenure at the top
    // of USER AWARENESS for the same reason; profiler mirrors it.
    //
    // Anchor on the sections-array opener, then walk forward by line
    // until we reach the first non-comment, non-blank line — that must
    // be the buildAccountSection call. This shape is robust to any
    // number of intervening comment lines explaining the placement.
    const anchor = profilerSource.indexOf('const sections = [');
    expect(anchor).toBeGreaterThan(0);
    const tail = profilerSource.slice(anchor);
    const lines = tail.split('\n').slice(1); // skip "const sections = ["
    const firstMeaningful = lines.find((l) => {
      const trimmed = l.trim();
      return trimmed.length > 0 && !trimmed.startsWith('//');
    });
    expect(firstMeaningful).toBeDefined();
    expect(firstMeaningful!.trim()).toBe('buildAccountSection(account, now),');
  });
});
