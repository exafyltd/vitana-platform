// VTID-05010 — the voice diary episode repair (data fix-up). Behaviour is proven
// on a throwaway Postgres by scripts/ci/test-vtid-05010-diary-repair.sh; this suite
// pins the fix-up to the two owner-approved rows and to writeDiaryEpisode()'s shape.
import { readFileSync } from 'fs';
import { join } from 'path';
import { diaryCategoryFromTags } from '../src/services/memory/diary';

const root = join(__dirname, '../../..');
const sql = readFileSync(
  join(root, 'supabase/migrations/data-fixups/20261009200000_vtid_05010_voice_diary_episode_repair.sql'),
  'utf8',
);
const code = sql
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');

describe('VTID-05010 voice diary episode repair', () => {
  it('touches exactly the two owner-approved diary rows', () => {
    const ids = Array.from(new Set(code.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g)));
    expect(ids.sort()).toEqual(["'6b40de35-72c3-42da-9bba-5d82c27cbe96'", "'a1a77e84-6db9-466d-8257-9376f0a6bc4f'"]);
  });

  it('writes only memory_items, inside one transaction, and never updates or deletes', () => {
    expect(code).toMatch(/^BEGIN;/m);
    expect(code).toMatch(/^COMMIT;/m);
    expect((code.match(/INSERT INTO\s+public\.(\w+)/g) || []).map((s) => s.split('.')[1])).toEqual(['memory_items']);
    expect(code).not.toMatch(/\b(UPDATE|DELETE)\b/i);
  });

  it('is idempotent and guarded', () => {
    expect(code).toContain("m.content_json->>'diary_entry_id' = d.id::text");
    expect(code).toMatch(/NOT EXISTS/);
    expect(code).toContain('IF n <> 2 THEN');
    expect(code).toContain('ut.is_primary');
  });

  it('matches writeDiaryEpisode(): personal, source diary, notes, importance 50, no sensitivity/embedding', () => {
    expect(diaryCategoryFromTags(['diary', 'voice', 'orb'])).toBe('notes');
    const cols = code.match(/INSERT INTO public\.memory_items\s*\(([^)]*)\)/)![1].split(',').map((c) => c.trim());
    expect(cols).toEqual(['tenant_id', 'user_id', 'active_role', 'source', 'category_key', 'content', 'content_json', 'importance', 'occurred_at']);
    expect(code).toMatch(/NULL,\s*'diary',\s*'notes',\s*d\.text,/);
    expect(code).toMatch(/50,\s*d\.created_at/);
    for (const k of ["'kind', 'diary'", "'diary_entry_id', d.id::text", "'diary_source', d.source", "'tags'"]) expect(code).toContain(k);
  });

  it('runs under any SQL runner (no psql-only meta-commands)', () => {
    expect(code).not.toMatch(/^\s*\\/m);
  });
});
