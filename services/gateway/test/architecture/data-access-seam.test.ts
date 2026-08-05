import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * VTID-03498 (Aurora migration B1) — the ratchet.
 *
 * Moving a file behind the data-access seam is worthless if the next PR adds a
 * fresh `supabase.from()` to it. This test seals the files that have been
 * migrated: once a file is on the list, it must not talk to supabase-js
 * directly again.
 *
 * The Supabase→Aurora migration (VTID-03494, Option B) has to relocate ~2,480
 * `.from()` call sites. That only converges if the count goes one way.
 *
 * TO MIGRATE A FILE:
 *   1. Move its queries into a `*-repository.ts` under src/services/<domain>/.
 *   2. Add the file here.
 *   3. This test now guards it.
 *
 * Repository modules themselves are of course allowed to import supabase-js —
 * they are the seam. At Aurora cutover they are what changes.
 */

const GATEWAY_SRC = join(__dirname, '..', '..', 'src');

/** Files fully migrated behind a repository. These must stay at zero. */
const SEALED_FILES = [
  'routes/specialists-admin.ts',
  'routes/tenant-specialists.ts',
];

/**
 * Partially-migrated files: one bounded context has moved behind a repository,
 * another has not yet. A zero-seal would be a lie, but leaving them unguarded
 * lets the count drift back up, so they get a ceiling instead — the number may
 * only ever go DOWN.
 *
 * Lower the number as you migrate; never raise it. Raising it is the signal
 * that someone added a direct query to a file that was being migrated out.
 */
const CAPPED_FILES: Array<{ file: string; maxCallSites: number; note: string }> = [
  // Empty right now — tenant-specialists.ts graduated to SEALED once its
  // feedback-ticket half also moved behind a repository. The machinery stays:
  // the next large file will land here first and graduate the same way.
];

/** Count `.from('table')` occurrences — the unit the migration is measured in. */
function countCallSites(src: string): number {
  return (src.match(/\.from\(\s*['"`][a-zA-Z0-9_]+['"`]/g) ?? []).length;
}

/** Direct supabase-js usage. `Buffer.from(` must not match, hence the receiver. */
const FORBIDDEN = [
  { pattern: /from\s+['"]@supabase\/supabase-js['"]/, label: "import from '@supabase/supabase-js'" },
  { pattern: /\bcreateClient\s*\(/, label: 'createClient(' },
  { pattern: /\bsupabase\s*\.\s*from\s*\(/, label: 'supabase.from(' },
  { pattern: /\bsupabase\s*\.\s*rpc\s*\(/, label: 'supabase.rpc(' },
  { pattern: /\bgetSupabase\s*\(/, label: 'getSupabase(' },
  { pattern: /\bgetServiceClient\s*\(/, label: 'getServiceClient(' },
];

describe('data-access seam (VTID-03498)', () => {
  it.each(SEALED_FILES)('%s has no direct supabase-js usage', (rel) => {
    const path = join(GATEWAY_SRC, rel);
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, 'utf8');

    const violations = FORBIDDEN.filter(({ pattern }) => pattern.test(src)).map((f) => f.label);

    expect(violations).toEqual([]);
  });

  it('every sealed file exists (catches renames silently dropping the guard)', () => {
    for (const rel of SEALED_FILES) {
      expect(existsSync(join(GATEWAY_SRC, rel))).toBe(true);
    }
  });

  it('the seal list is non-empty', () => {
    // If someone empties this to make CI pass, that should itself fail.
    expect(SEALED_FILES.length).toBeGreaterThan(0);
  });

  describe('partially-migrated files may only shrink', () => {
    // `it.each([])` throws, so the empty case needs its own branch. Empty is a
    // legitimate state: it means every file currently under migration has
    // graduated to SEALED.
    if (CAPPED_FILES.length === 0) {
      it('no files are mid-migration right now', () => {
        expect(CAPPED_FILES).toEqual([]);
      });
    } else {
      it.each(CAPPED_FILES.map((c) => [c.file, c.maxCallSites] as const))(
        '%s has at most %i supabase call sites',
        (rel, max) => {
          const path = join(GATEWAY_SRC, rel);
          expect(existsSync(path)).toBe(true);
          const actual = countCallSites(readFileSync(path, 'utf8'));

          // Going UP means a direct query was added to a file mid-migration.
          expect(actual).toBeLessThanOrEqual(max);

          // Going DOWN is good — but the cap must be lowered to lock the gain
          // in, otherwise the ratchet silently loosens.
          if (actual < max) {
            throw new Error(
              `${rel} is now at ${actual} call sites (cap ${max}). ` +
                `Lower maxCallSites to ${actual} in data-access-seam.test.ts to lock in the progress.`,
            );
          }
        },
      );
    }
  });
});
