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

/** Files that have been migrated behind a repository and must stay clean. */
const SEALED_FILES = [
  'routes/specialists-admin.ts',
];

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
});
