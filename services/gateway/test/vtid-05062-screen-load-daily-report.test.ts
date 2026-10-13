/**
 * VTID-05062: daily production screen-load report — aggregation over
 * fixture events (no network, no database).
 */

import {
  BUDGETS,
  TAB_SCREENS,
  buildDailyReport,
  checkBuild,
  parseAppVersion,
  percentile,
  type DailyReportDeps,
  type EventRow,
} from '../src/services/screen-load-daily-report';

const NOW = new Date('2026-10-10T05:52:00.000Z');
const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12';
const HTML_OK = `<!doctype html><html><head><meta charset="utf-8"><meta name="vitana-app-version" content="${COMMIT.slice(0, 12)}"></head><body><div id="root"></div></body></html>`;

function nav(screen: string, kind: 'first' | 'return', ready: number, refetch = 0, env = 'production'): EventRow {
  return { created_at: NOW.toISOString(), metadata: { screen, nav: kind, ready_ms: ready, img_refetch: refetch, img_total: 6, env } };
}
function lcp(value: number, metric = 'LCP', env = 'production'): EventRow {
  return { created_at: NOW.toISOString(), metadata: { metric, value, env, screen: '/home' } };
}
/** n samples 1..n scaled so that the nearest-rank p75 is exactly `p75`. */
function series(n: number, p75: number): number[] {
  const rank = Math.ceil(0.75 * n);
  return Array.from({ length: n }, (_, i) => Math.round(((i + 1) / rank) * p75));
}

/** Every tab screen healthy with 25 samples each. */
function healthyNav(): EventRow[] {
  const rows: EventRow[] = [];
  for (const s of TAB_SCREENS) {
    for (const v of series(25, 800)) rows.push(nav(s, 'return', v));
    for (const v of series(25, 2000)) rows.push(nav(s, 'first', v));
  }
  return rows;
}
function healthyLcp(): EventRow[] {
  return series(30, 3000).map((v) => lcp(v));
}

function deps(over: Partial<{ nav: EventRow[]; latency: EventRow[]; html: string | null; commits: string[] }> = {}): DailyReportDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    now: NOW,
    fetchEvents: async (topic, since) => {
      calls.push(`${topic}@${since}`);
      if (topic === 'screen.nav.measured') return over.nav ?? healthyNav();
      if (topic === 'screen.latency.measured') return over.latency ?? healthyLcp();
      return [];
    },
    fetchProdHtml: async () => (over.html === undefined ? HTML_OK : over.html),
    fetchVerifiedCommits: async () => over.commits ?? [COMMIT],
  };
}

describe('percentile (nearest rank)', () => {
  it('matches the routine-audits definition', () => {
    expect(percentile([], 75)).toBeNull();
    expect(percentile([5], 75)).toBe(5);
    expect(percentile([1, 2, 3, 4], 75)).toBe(3);
    expect(percentile([4, 1, 3, 2, 5, 6, 7, 8], 75)).toBe(6);
  });
});

describe('buildDailyReport — healthy day', () => {
  it('is green / ok with p75 values per screen, and reads the last 24 h', async () => {
    const d = deps();
    const r = await buildDailyReport(d);
    expect(r.status).toBe('green');
    expect(r.health).toBe('ok');
    expect(r.report_date).toBe('2026-10-10');
    expect(r.window.since).toBe('2026-10-09T05:52:00.000Z');
    expect(d.calls).toContain('screen.nav.measured@2026-10-09T05:52:00.000Z');
    expect(r.screens.map((s) => s.screen)).toEqual([...TAB_SCREENS]);
    for (const s of r.screens) {
      expect(s.return_p75_ms).toMatchObject({ value: 800, samples: 25, verdict: 'pass', budget: 1000 });
      expect(s.first_p75_ms).toMatchObject({ value: 2000, samples: 25, verdict: 'pass', budget: 3000 });
      expect(s.refetch_share).toMatchObject({ value: 0, samples: 25, verdict: 'pass' });
    }
    expect(r.lcp_p75_ms).toMatchObject({ value: 3000, samples: 30, verdict: 'pass' });
    expect(r.build).toMatchObject({ verdict: 'pass', prod_version: COMMIT.slice(0, 12), matched_commit: COMMIT });
    expect(r.gchat_text).toContain('🟢');
    expect(r.gchat_text).toContain('/comm/events-meetups');
  });
});

describe('buildDailyReport — budgets', () => {
  it('return p75 over 1000 ms → red, worst screen named', async () => {
    const rows = healthyNav().filter((e) => !(e.metadata!.screen === '/inbox' && e.metadata!.nav === 'return'));
    for (const v of series(25, 1800)) rows.push(nav('/inbox', 'return', v));
    const r = await buildDailyReport(deps({ nav: rows }));
    const inbox = r.screens.find((s) => s.screen === '/inbox')!;
    expect(inbox.return_p75_ms).toMatchObject({ value: 1800, verdict: 'breach' });
    expect(r.status).toBe('red');
    expect(r.health).toBe('down');
    expect(r.worst).toMatchObject({ screen: '/inbox', measure: 'return_p75_ms', value: 1800 });
    expect(r.gchat_text).toContain('🔴');
    expect(r.gchat_text).toMatch(/Worst: \/inbox/);
  });

  it('refetch share: 2 of 25 return visits re-downloaded a photo = 8% → red', async () => {
    const rows = healthyNav().filter((e) => !(e.metadata!.screen === '/home' && e.metadata!.nav === 'return'));
    series(25, 800).forEach((v, i) => rows.push(nav('/home', 'return', v, i < 2 ? 3 : 0)));
    const r = await buildDailyReport(deps({ nav: rows }));
    const home = r.screens.find((s) => s.screen === '/home')!;
    expect(home.refetch_share).toMatchObject({ value: 0.08, samples: 25, verdict: 'breach' });
    expect(r.status).toBe('red');
  });

  it('refetch share: 1 of 25 = 4% passes', async () => {
    const rows = healthyNav().filter((e) => !(e.metadata!.screen === '/home' && e.metadata!.nav === 'return'));
    series(25, 800).forEach((v, i) => rows.push(nav('/home', 'return', v, i === 0 ? 1 : 0)));
    const r = await buildDailyReport(deps({ nav: rows }));
    expect(r.screens.find((s) => s.screen === '/home')!.refetch_share).toMatchObject({ value: 0.04, verdict: 'pass' });
    expect(r.status).toBe('green');
  });

  it('LCP p75 over 4000 → red', async () => {
    const r = await buildDailyReport(deps({ latency: series(30, 5224).map((v) => lcp(v)) }));
    expect(r.lcp_p75_ms).toMatchObject({ value: 5224, verdict: 'breach' });
    expect(r.status).toBe('red');
  });

  it('LCP aggregation ignores every other metric', async () => {
    const latency = [
      ...healthyLcp(),
      ...Array.from({ length: 50 }, () => lcp(99999, 'TTFB')),
      ...Array.from({ length: 50 }, () => lcp(99999, 'FCP')),
      ...Array.from({ length: 50 }, () => lcp(0.9, 'CLS')),
    ];
    const r = await buildDailyReport(deps({ latency }));
    expect(r.lcp_p75_ms).toMatchObject({ value: 3000, samples: 30, verdict: 'pass' });
  });

  it('staging events never count toward the production numbers', async () => {
    const rows = [...healthyNav(), ...Array.from({ length: 200 }, () => nav('/home', 'return', 9999, 5, 'staging'))];
    const latency = [...healthyLcp(), ...Array.from({ length: 200 }, () => lcp(20000, 'LCP', 'staging'))];
    const r = await buildDailyReport(deps({ nav: rows, latency }));
    expect(r.status).toBe('green');
    expect(r.screens.find((s) => s.screen === '/home')!.return_p75_ms.samples).toBe(25);
    expect(r.lcp_p75_ms.samples).toBe(30);
  });

  it('screens outside the tab list are ignored', async () => {
    const rows = [...healthyNav(), ...Array.from({ length: 30 }, () => nav('/comm/groups/:id', 'return', 9999, 4))];
    const r = await buildDailyReport(deps({ nav: rows }));
    expect(r.status).toBe('green');
    expect(r.screens).toHaveLength(TAB_SCREENS.length);
  });
});

describe('buildDailyReport — insufficient data', () => {
  it(`fewer than ${BUDGETS.min_samples} samples → insufficient → yellow, never green`, async () => {
    const rows = healthyNav().filter((e) => !(e.metadata!.screen === '/autopilot' && e.metadata!.nav === 'first'));
    for (const v of series(19, 500)) rows.push(nav('/autopilot', 'first', v));
    const r = await buildDailyReport(deps({ nav: rows }));
    const ap = r.screens.find((s) => s.screen === '/autopilot')!;
    expect(ap.first_p75_ms).toMatchObject({ samples: 19, verdict: 'insufficient' });
    expect(r.status).toBe('yellow');
    expect(r.health).toBe('degraded');
    expect(r.gchat_text).toContain('🟡');
  });

  it('no telemetry at all → yellow (insufficient), not green', async () => {
    const r = await buildDailyReport(deps({ nav: [], latency: [] }));
    expect(r.status).toBe('yellow');
    for (const s of r.screens) {
      expect(s.return_p75_ms).toMatchObject({ value: null, samples: 0, verdict: 'insufficient' });
      expect(s.refetch_share.verdict).toBe('insufficient');
    }
    expect(r.lcp_p75_ms.verdict).toBe('insufficient');
    expect(r.worst).toBeNull();
  });

  it('a breach beats insufficient data → red', async () => {
    const r = await buildDailyReport(deps({ nav: [], latency: series(30, 6000).map((v) => lcp(v)) }));
    expect(r.status).toBe('red');
  });
});

describe('build check', () => {
  it('12-char short SHA matches a verified 40-char commit by prefix', () => {
    expect(checkBuild(HTML_OK, ['0'.repeat(40), COMMIT])).toEqual({
      verdict: 'pass',
      prod_version: COMMIT.slice(0, 12),
      matched_commit: COMMIT,
      reason: 'matched',
    });
  });

  it('attribute order and case do not matter', () => {
    expect(parseAppVersion(`<META content="${COMMIT.slice(0, 12).toUpperCase()}" name='vitana-app-version' />`)).toBe(COMMIT.slice(0, 12));
  });

  it('version not verified on staging → red', async () => {
    const r = await buildDailyReport(deps({ commits: ['1111111111111111111111111111111111111111'] }));
    expect(r.build).toMatchObject({ verdict: 'fail', reason: 'no_verified_commit', prod_version: COMMIT.slice(0, 12) });
    expect(r.status).toBe('red');
    expect(r.gchat_text).toContain('NOT verified on staging');
  });

  it('missing meta tag → red', async () => {
    const r = await buildDailyReport(deps({ html: '<html><head></head><body></body></html>' }));
    expect(r.build).toMatchObject({ verdict: 'fail', reason: 'meta_missing', prod_version: null });
    expect(r.status).toBe('red');
  });

  it('non-hex meta content counts as missing', () => {
    expect(parseAppVersion('<meta name="vitana-app-version" content="dev">')).toBeNull();
  });

  it('production HTML unavailable (null or throwing fetcher) → red', async () => {
    expect((await buildDailyReport(deps({ html: null }))).build.reason).toBe('html_unavailable');
    const d = deps();
    d.fetchProdHtml = async () => {
      throw new Error('ECONNRESET');
    };
    const r = await buildDailyReport(d);
    expect(r.build.reason).toBe('html_unavailable');
    expect(r.status).toBe('red');
  });
});
