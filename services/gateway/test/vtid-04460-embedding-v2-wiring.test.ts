// VTID-04460: intent and ledger embeddings use the Titan V2 column and the
// _v2 SQL functions. The previous gateway keeps the old column/functions
// until prod runs this code (expand/contract, shared database).
import { readFileSync } from 'fs';
import { join } from 'path';

const src = (p: string) => readFileSync(join(__dirname, '../src', p), 'utf8');
const mig = readFileSync(
  join(__dirname, '../../../supabase/migrations/20260924090000_vtid_04460_intent_ledger_embeddings_titan_v2.sql'),
  'utf8',
);

describe('VTID-04460 writers and readers', () => {
  it('every user_intents embedding writer writes embedding_v2, never embedding', () => {
    for (const f of ['routes/intents-repository.ts', 'services/intent-find-match-repository.ts',
      'services/intent-embedding-worker-repository.ts', 'routes/orb-live.ts']) {
      const s = src(f);
      expect(s).not.toMatch(/from\('user_intents'\)\.update\(\{ embedding[:}\s]/);
    }
    expect(src('services/intent-embedding-worker-repository.ts')).toContain(".is('embedding_v2', null)");
  });

  it('readers call the _v2 functions', () => {
    expect(src('services/intent-find-match-repository.ts')).toContain("rpc('search_intent_catalog_v2'");
    expect(src('services/intent-matcher-repository.ts')).toContain("rpc('compute_intent_matches_v2'");
    expect(src('services/ledger-task-dedup.ts')).toContain('/rest/v1/rpc/find_similar_vtid_tasks_v2');
    expect(src('services/ledger-task-dedup.ts')).toContain('embedding_v2: embeddingStr');
  });
});

describe('VTID-04460 migration', () => {
  it('is additive: adds embedding_v2 and _v2 functions, drops and alters nothing', () => {
    expect(mig).toMatch(/ALTER TABLE public\.user_intents ADD COLUMN IF NOT EXISTS embedding_v2 vector\(1024\)/);
    expect(mig).toMatch(/ALTER TABLE public\.vtid_ledger\s+ADD COLUMN IF NOT EXISTS embedding_v2 vector\(1024\)/);
    expect(mig).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
    expect(mig).not.toMatch(/ALTER\s+COLUMN/i);
    for (const fn of ['compute_intent_matches_v2', 'search_intent_catalog_v2', 'find_similar_vtid_tasks_v2']) {
      expect(mig).toContain(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    }
  });

  it('the _v2 functions read only embedding_v2, and the catalog cast matches Titan V2', () => {
    const bodies = mig.slice(mig.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(bodies).not.toMatch(/\b(src|ui|vl)\.embedding\b(?!_v2)/);
    expect(bodies).toContain('::vector(1024)');
    expect(bodies).not.toContain('vector(768)');
  });

  it('the _v2 functions are not callable by anon', () => {
    for (const fn of ['compute_intent_matches_v2', 'search_intent_catalog_v2', 'find_similar_vtid_tasks_v2']) {
      expect(mig).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon`));
    }
    expect(mig).not.toMatch(/GRANT[^;]*TO[^;]*\banon\b/);
  });
});
