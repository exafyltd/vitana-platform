/**
 * VTID-04607 — the voice redirect suite in CI: 50 spoken requests to open a
 * screen, sent through the real `navigate` tool (NAV_V2_ENABLED) with the
 * bundled registry snapshot and its stored Titan vectors. No network.
 *
 * Hard rules, for every case:
 *   - the expected screen opens (with the right route and entry kind for
 *     the device), or it is handed to the voice model first in the list;
 *   - no case ever opens, or puts first, a different screen.
 * And a ratchet: a case that opens on its own today may not fall back to a
 * hand-off. After a change that legitimately moves cases, regenerate:
 *
 *   NAV_REDIRECT_WRITE_BASELINE=1 npx jest test/nav-redirect
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true }),
  DEV_IDENTITY: { USER_ID: '00000000-0000-0000-0000-000000000099', TENANT_ID: '00000000-0000-0000-0000-000000000001' },
  isMemoryBridgeEnabled: () => false,
  isDevSandbox: () => false,
}));

import * as fs from 'fs';
import * as path from 'path';
import { loadBundledEmbeddings } from '../../src/navigation/nav-embedder';
import { isVoiceTarget, loadSnapshotRegistry } from '../../src/navigation/nav-registry';
import { __setNavServiceForTests } from '../../src/navigation/nav-service';
import { loadRegistryFixture } from '../nav-golden/registry-fixture';
import { PARAPHRASE_CASES, REDIRECT_CASES } from './redirect-cases';
import { formatRedirectTable, RedirectResult, runParaphraseCase, runRedirectCase, summarizeRedirect } from './redirect-harness';

const BASELINE_FILE = path.join(__dirname, 'baseline.redirect.json');

describe('VTID-04607 redirect suite — the cases themselves', () => {
  const screens = new Map(loadSnapshotRegistry().registry.screens.map((s) => [s.id, s]));

  it('has 50 cases with unique ids and unique sentences', () => {
    expect(REDIRECT_CASES.length).toBeGreaterThanOrEqual(50);
    expect(new Set(REDIRECT_CASES.map((c) => c.id)).size).toBe(REDIRECT_CASES.length);
    expect(new Set(REDIRECT_CASES.map((c) => `${c.lang}|${c.say.trim().toLowerCase()}`)).size).toBe(REDIRECT_CASES.length);
  });

  it('only expects screens that exist and that a voice request can open', () => {
    const bad = REDIRECT_CASES.flatMap((c) =>
      c.expect.filter((id) => !screens.has(id) || !isVoiceTarget(screens.get(id)!)).map((id) => `${c.id}: ${id}`),
    );
    expect(bad).toEqual([]);
  });

  it('covers popups, a mobile session and several languages', () => {
    const popups = REDIRECT_CASES.filter((c) => c.expect.some((id) => screens.get(id)?.overlay));
    expect(popups.length).toBeGreaterThanOrEqual(3);
    expect(REDIRECT_CASES.some((c) => c.viewport === 'mobile')).toBe(true);
    expect(new Set(REDIRECT_CASES.map((c) => c.lang)).size).toBeGreaterThanOrEqual(5);
  });

  it('has a stored vector for every sentence (else run test/nav-golden/build-embeddings.ts)', () => {
    const stored = loadBundledEmbeddings();
    expect(REDIRECT_CASES.filter((c) => !stored.has(c.say.trim())).map((c) => c.id)).toEqual([]);
    expect(PARAPHRASE_CASES.filter((p) => !stored.has(p.say.trim()) || !stored.has(p.modelQuestion.trim())).map((p) => p.id)).toEqual([]);
  });
});

describe('VTID-04607 redirect suite — through the navigate tool', () => {
  let results: RedirectResult[];

  beforeAll(async () => {
    process.env.NAV_V2_ENABLED = 'true';
    const f = await loadRegistryFixture();
    __setNavServiceForTests({ index: f.index, embedder: f.embedder });
    results = [];
    for (const c of REDIRECT_CASES) results.push(await runRedirectCase(c));
    const s = summarizeRedirect(results);
    // eslint-disable-next-line no-console
    console.log(`redirect suite: ${s.open} open, ${s.handoff} handed to the voice model, ${s.wrong} wrong, ${s.none} none of ${s.total}\n${formatRedirectTable(results)}`);
    if (process.env.NAV_REDIRECT_WRITE_BASELINE === '1') {
      const outcomes = Object.fromEntries(results.map((r) => [r.id, r.outcome]));
      fs.writeFileSync(BASELINE_FILE, JSON.stringify({ ...s, outcomes }, null, 2) + '\n');
    }
  }, 120_000);

  afterAll(() => {
    delete process.env.NAV_V2_ENABLED;
  });

  it.each(REDIRECT_CASES.map((c) => [c.id, c.say, c] as const))('%s "%s" reaches the right screen', (id) => {
    const r = results.find((x) => x.id === id)!;
    expect({ id, outcome: r.outcome, problems: r.problems }).toEqual({
      id,
      outcome: expect.stringMatching(/^(open|handoff)$/),
      problems: [],
    });
  });

  it('no case that opens on its own today falls back to a hand-off', () => {
    const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) as { outcomes: Record<string, string> };
    const regressed = results.filter((r) => base.outcomes[r.id] === 'open' && r.outcome !== 'open').map((r) => r.id);
    expect(regressed).toEqual([]);
  });
});

describe('VTID-04607 redirect suite — when the voice model shortens the request', () => {
  beforeAll(async () => {
    process.env.NAV_V2_ENABLED = 'true';
    const f = await loadRegistryFixture();
    __setNavServiceForTests({ index: f.index, embedder: f.embedder });
  });

  afterAll(() => {
    delete process.env.NAV_V2_ENABLED;
  });

  it.each(PARAPHRASE_CASES.map((p) => [p.id, p.modelQuestion, p.say, p] as const))(
    '%s question "%s" with the member saying "%s" reaches the right screen',
    async (_id, _q, _say, p) => {
      const r = await runParaphraseCase(p);
      expect({ outcome: r.outcome, screen: r.screen_id, problems: r.problems }).toEqual({
        outcome: expect.stringMatching(/^(open|handoff)$/),
        screen: expect.any(String),
        problems: [],
      });
    },
  );
});
