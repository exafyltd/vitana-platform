/**
 * VTID-04762 — Audiobook Season 0 (Prolog) migration invariants.
 *
 * The migration was executed end to end against an in-memory Postgres
 * (PGlite) mirroring the live schema — 94/254 → 100/260, member pointers,
 * snapshot rewrite, idempotent re-run (docs/validation/VTID-04762). This
 * test pins the properties a later edit must not break.
 */
import fs from 'fs';
import path from 'path';

const sql = fs.readFileSync(
  path.join(__dirname, '../../../supabase/migrations/20261001120000_VTID_04762_audiobook_season0_prolog.sql'),
  'utf8',
);

describe('VTID-04762 Prolog migration', () => {
  it('prepends T255-T260 as sessions 1-6 in the prolog chapter', () => {
    ['T255', 'T256', 'T257', 'T258', 'T259', 'T260'].forEach((id, i) => {
      expect(sql).toMatch(new RegExp(`\\('${id}', 'v2', ${i + 1}, 1, 'prolog',`));
    });
  });

  it('shifts the curriculum, the session bound and member pointers by exactly six', () => {
    expect(sql).toContain('SET session = session + 1000');
    expect(sql).toContain('SET session = session - 994');
    expect(sql).toContain('CHECK (session BETWEEN 1 AND 100)');
    expect(sql).toContain('SET current_session = LEAST(current_session + 6, 100)');
    expect(sql).toContain('WHERE current_session > 1');
    expect(sql).toContain("to_jsonb(((e.elem->>'session')::int) + 6)");
  });

  it('is guarded so a re-run changes nothing', () => {
    expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM journey_checklist_topics WHERE topic_id = 'T255')");
    expect(sql).toContain('ON CONFLICT (topic_id) DO NOTHING');
    expect(sql).toContain('ON CONFLICT (topic_id, locale) DO NOTHING');
    expect(sql).toContain('NOT v.snapshot @> \'[{"topicId": "T255"}]\'::jsonb');
    expect(sql.trim().startsWith('--')).toBe(true);
    expect(sql).toMatch(/BEGIN;[\s\S]*COMMIT;\s*$/);
  });

  it('ships German narration in du-form and English narration for every episode', () => {
    const scripts = [...sql.matchAll(/\$vs\$([\s\S]*?)\$vs\$/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(12);
    const german = scripts.slice(0, 6);
    for (const s of german) {
      expect(s).not.toMatch(/\b(Sie|Ihr|Ihnen)\b/);
      // One Polly request per episode (3,000-char limit, 2,800 safe chunk).
      expect(s.length).toBeLessThan(2800);
    }
    expect(scripts.slice(6).every((s) => /[a-z]/.test(s) && s.length > 300)).toBe(true);
  });

  it('makes no health promises', () => {
    expect(sql).not.toMatch(/\b(heilt|garantiert|cures?|guarantee[sd]?)\b/i);
    expect(sql).toContain('ersetze keine ärztliche Beratung');
  });
});
