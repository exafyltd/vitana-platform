/**
 * DEFECT 2 (docs/CONVERSATION_DEFECTS_FIX_PLAN.md) — exact-name
 * short-circuit in runFindMatch.
 *
 * Symptom: the user names "Mariia Maksina", the catalog finds her (100%),
 * and the assistant still asks the user to choose among 3 names. A named
 * query with an exact person hit must select that person directly — no
 * verbal ballot. A named query whose top candidate dominates by ≥0.15
 * short-circuits the same way. Unnamed queries keep the full ranked list.
 */

process.env.SUPABASE_URL = 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE = 'test-key';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));
jest.mock('../../src/services/intent-classifier', () => ({
  classifyIntentKind: jest.fn(),
}));
jest.mock('../../src/services/intent-extractor', () => ({
  extractIntent: jest.fn(),
  friendlyMissingFields: jest.fn(() => 'a time'),
}));
jest.mock('../../src/services/intent-embedding', () => ({
  embedIntent: jest.fn(async () => null),
}));
jest.mock('../../src/services/intent-matcher', () => ({
  computeForIntent: jest.fn(),
  surfaceTopMatches: jest.fn(async () => []),
}));
jest.mock('../../src/services/social-memory/social-memory-repository', () => ({
  resolvePersonByName: jest.fn(),
}));

import { createClient } from '@supabase/supabase-js';
import { extractIntent } from '../../src/services/intent-extractor';
import { resolvePersonByName } from '../../src/services/social-memory/social-memory-repository';
import { runFindMatch } from '../../src/services/intent-find-match';

const IDENT = { user_id: 'u-1', tenant_id: 't-1' };

const CANDIDATES = [
  {
    cand_intent_id: 'i-1',
    cand_user_id: 'p-mariia',
    cand_vitana_id: 'mariia.maksina',
    cand_kind: 'activity_seek',
    cand_title: 'Tennis am Samstag',
    cand_scope: 'berlin',
    score: 0.82,
    reasons: { activity_exact: true },
  },
  {
    cand_intent_id: 'i-2',
    cand_user_id: 'p-kemal',
    cand_vitana_id: 'kemal',
    cand_kind: 'activity_seek',
    cand_title: 'Tennis Doppel',
    cand_scope: 'berlin',
    score: 0.8,
    reasons: { activity_exact: true },
  },
  {
    cand_intent_id: 'i-3',
    cand_user_id: 'p-lena',
    cand_vitana_id: 'lena',
    cand_kind: 'activity_seek',
    cand_title: 'Badminton',
    cand_scope: 'berlin',
    score: 0.55,
    reasons: { activity_exact: false },
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  (createClient as jest.Mock).mockReturnValue({
    rpc: jest.fn(async () => ({ data: CANDIDATES, error: null })),
  });
  // Incomplete extract → complete=false → the recommend path never
  // persists an intent (keeps the test free of insert side-effect mocks).
  (extractIntent as jest.Mock).mockResolvedValue({
    category: 'sport',
    title: 'Tennis',
    scope: 'berlin',
    kind_payload: {},
    confidence: 0.9,
    missing_critical: ['time_window'],
  });
});

describe('runFindMatch — exact-name short-circuit (defect 2)', () => {
  it('a named query with an exact person hit returns ONLY that person', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue({
      user_id: 'p-mariia',
      display_name: 'Mariia Maksina',
      handle: 'mariia.maksina',
    });
    const res = await runFindMatch(
      { utterance: 'Ich möchte mit Mariia Maksina Tennis spielen', kind_hint: 'activity_seek' },
      IDENT,
    );
    expect(res.ok).toBe(true);
    expect(res.stage).toBe('matched');
    const matches = (res.data as any).matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].intent_id).toBe('i-1');
    expect((res.data as any).exact_person_match).toBe(true);
    expect(res.text).toContain('nothing to disambiguate');
    expect(res.text).toContain('Do NOT mention, list, or ask about any other candidates');
  });

  it('falls back to a vitana_id string match when profile resolution fails', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(null);
    const res = await runFindMatch(
      { utterance: 'Verbinde mich mit Mariia Maksina bitte', kind_hint: 'activity_seek' },
      IDENT,
    );
    const matches = (res.data as any).matches;
    // "Mariia Maksina" normalizes to "mariiamaksina" === cand_vitana_id
    // "mariia.maksina" normalized.
    expect(matches).toHaveLength(1);
    expect(matches[0].intent_id).toBe('i-1');
    expect((res.data as any).exact_person_match).toBe(true);
  });

  it('a named query with a dominant top score (≥0.15 gap) selects the top only', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue(null);
    const dominant = [
      { ...CANDIDATES[0], cand_vitana_id: 'someone.else', score: 0.9 },
      { ...CANDIDATES[2], score: 0.6 },
    ];
    (createClient as jest.Mock).mockReturnValue({
      rpc: jest.fn(async () => ({ data: dominant, error: null })),
    });
    const res = await runFindMatch(
      { utterance: 'Gibt es ein Match mit Anna Schmidt für Tennis?', kind_hint: 'activity_seek' },
      IDENT,
    );
    const matches = (res.data as any).matches;
    expect(matches).toHaveLength(1);
    expect((res.data as any).exact_person_match).toBe(false);
  });

  it('an UNNAMED query keeps the full ranked list (no behavior change)', async () => {
    const res = await runFindMatch(
      { utterance: 'ich suche jemanden zum tennis spielen', kind_hint: 'activity_seek' },
      IDENT,
    );
    const matches = (res.data as any).matches;
    expect(matches).toHaveLength(3);
    expect((res.data as any).exact_person_match).toBe(false);
    expect(res.text).not.toContain('nothing to disambiguate');
  });

  it('a named query with NO matching candidate keeps the full list', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue({
      user_id: 'p-unknown',
      display_name: 'Jemand Anderes',
      handle: 'jemand',
    });
    const res = await runFindMatch(
      // Close scores (0.82 vs 0.80) → dominance gap not met either.
      { utterance: 'Spielt Jemand Anderes auch Tennis?', kind_hint: 'activity_seek' },
      IDENT,
    );
    const matches = (res.data as any).matches;
    expect(matches).toHaveLength(3);
    expect((res.data as any).exact_person_match).toBe(false);
  });

  it('partner_seek queries never run the person short-circuit (identity stays redacted)', async () => {
    (resolvePersonByName as jest.Mock).mockResolvedValue({
      user_id: 'p-mariia',
      display_name: 'Mariia Maksina',
      handle: 'mariia.maksina',
    });
    const res = await runFindMatch(
      { utterance: 'Suche eine Partnerin wie Mariia Maksina', kind_hint: 'partner_seek' },
      IDENT,
    );
    expect(resolvePersonByName).not.toHaveBeenCalled();
    const matches = (res.data as any).matches;
    expect(matches).toHaveLength(3);
    // Partner identities stay redacted.
    expect(matches[0].vitana_id).toBeNull();
  });
});
