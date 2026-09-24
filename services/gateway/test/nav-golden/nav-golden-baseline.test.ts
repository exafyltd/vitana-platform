/**
 * VTID-04496 — baseline of the CURRENT navigator against the golden set.
 *
 * Runs consultNavigator (keyword path over the static catalog; embeddings,
 * knowledge hub and memory mocked off so the run is deterministic and never
 * touches the network) through the golden harness, prints the full report,
 * and ratchets against baseline.legacy.json: the legacy navigator may not get
 * WORSE while the rebuild is in progress. When a change legitimately improves
 * it, regenerate the file:
 *
 *   NAV_GOLDEN_WRITE_BASELINE=1 npx jest test/nav-golden/nav-golden-baseline.test.ts
 *
 * Production runs with embeddings on, so this is the keyword-only lower bound
 * of the legacy system, not its exact production behaviour. The production
 * failures in the golden set (news → cart etc.) are kept as cases regardless.
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/services/knowledge-hub', () => ({
  searchKnowledgeDocs: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../src/services/context-pack-builder', () => ({
  buildContextPack: jest.fn().mockResolvedValue({ memory_hits: [] }),
}));
jest.mock('../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true, id: 'golden' }),
}));
jest.mock('../../src/lib/navigation-catalog', () => {
  const actual = jest.requireActual('../../src/lib/navigation-catalog');
  return {
    ...actual,
    areCatalogEmbeddingsReady: () => false,
    semanticSearchCatalog: jest.fn().mockResolvedValue([]),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { GOLDEN_SET } from './golden-set';
import { evaluate, formatReport, summarize, Report } from './harness';
import { legacyResolver } from './legacy-resolver';

const BASELINE_FILE = path.join(__dirname, 'baseline.legacy.json');

describe('VTID-04496 golden navigation set — legacy navigator baseline', () => {
  let report: Report;

  beforeAll(async () => {
    report = await evaluate('legacy consultNavigator (keyword-only)', GOLDEN_SET, legacyResolver);
    // eslint-disable-next-line no-console
    console.log('\n' + formatReport(report) + '\n');
    if (process.env.NAV_GOLDEN_WRITE_BASELINE === '1') {
      fs.writeFileSync(BASELINE_FILE, JSON.stringify(summarize(report), null, 2) + '\n');
    }
  }, 120_000);

  it('evaluates every golden case', () => {
    expect(report.overall.total).toBe(GOLDEN_SET.length);
  });

  it('does not regress below the recorded baseline', () => {
    const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    const now = report.overall;
    expect({
      reaches_right_screen: now.reaches_right_screen >= base.overall.reaches_right_screen,
      wrong_screen: now.wrong_screen <= base.overall.wrong_screen,
      forbidden_hits: now.forbidden_hits <= base.overall.forbidden_hits,
      false_action: now.false_action <= base.overall.false_action,
    }).toEqual({ reaches_right_screen: true, wrong_screen: true, forbidden_hits: true, false_action: true });
  });
});
