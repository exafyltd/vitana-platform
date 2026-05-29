// VTID-03144 — structural anti-regression for the D42 fusion-audit
// Supabase boundary.
//
// Locks in the PR-1 boundary outcome: d42-context-fusion-engine.ts
// must not reach Supabase directly; the only DB write site for
// d42_fusion_audit is the new fusion-audit-writer module, which
// terminates the boundary via the approved `getSupabase()` +
// `createUserSupabaseClient(token)` helpers.
//
// If a future change reintroduces ANY of these patterns inside d42
// (raw `@supabase/supabase-js` import, `createClient(`, `getSupabase(`,
// `.from('d42_fusion_audit'`), this test fails — the leak has
// returned and PR-1's contract is broken.

import * as fs from 'fs';
import * as path from 'path';

const D42_PATH = path.resolve(
  __dirname,
  '../../../src/services/d42-context-fusion-engine.ts',
);
const WRITER_PATH = path.resolve(
  __dirname,
  '../../../src/services/decision-contract/fusion-audit-writer.ts',
);

// Read once at module load — these assertions are pure structural
// checks on the source text. The d42 prose intentionally references
// the boundary it just gave up (`@supabase/supabase-js`), but only
// inside backtick-quoted code spans inside `//` comments, so the
// regexes below (which require single or double quotes after `from`)
// do not collide with comment text.
const d42Code = fs.readFileSync(D42_PATH, 'utf8');
const writerCode = fs.readFileSync(WRITER_PATH, 'utf8');

describe('VTID-03144 D42 fusion-audit Supabase-boundary structural contract', () => {
  describe('d42-context-fusion-engine.ts has no direct Supabase reach', () => {
    it('does not import from @supabase/supabase-js', () => {
      // No `from '@supabase/supabase-js'` and no `from "@supabase/supabase-js"`.
      expect(d42Code).not.toMatch(/from\s+['"]@supabase\/supabase-js['"]/);
      // Also: no `require('@supabase/supabase-js')`.
      expect(d42Code).not.toMatch(/require\s*\(\s*['"]@supabase\/supabase-js['"]\s*\)/);
    });

    it('does not call createClient(', () => {
      expect(d42Code).not.toMatch(/\bcreateClient\s*\(/);
    });

    it('does not call getSupabase(', () => {
      // d42 must not reach even the approved boundary directly — the
      // writer owns that call site.
      expect(d42Code).not.toMatch(/\bgetSupabase\s*\(/);
    });

    it('does not write to d42_fusion_audit directly', () => {
      // No `.from('d42_fusion_audit'` or `.from("d42_fusion_audit"`.
      expect(d42Code).not.toMatch(/\.from\s*\(\s*['"]d42_fusion_audit['"]/);
    });

    it('does not reference SupabaseClient', () => {
      // The type import disappeared with the client builders.
      expect(d42Code).not.toMatch(/\bSupabaseClient\b/);
    });

    it('still exports storeFusionAudit (caller contract preserved)', () => {
      expect(d42Code).toMatch(/export\s+async\s+function\s+storeFusionAudit\s*\(/);
    });

    it('delegates to the decision-contract writer', () => {
      expect(d42Code).toMatch(
        /from\s+['"]\.\/decision-contract\/fusion-audit-writer['"]/,
      );
    });
  });

  describe('decision-contract/fusion-audit-writer.ts is the single DB write site', () => {
    it('owns the .from("d42_fusion_audit") insert', () => {
      expect(writerCode).toMatch(/\.from\s*\(\s*['"]d42_fusion_audit['"]/);
    });

    it('uses the approved getSupabase() helper for service-role writes', () => {
      expect(writerCode).toMatch(/from\s+['"]\.\.\/\.\.\/lib\/supabase['"]/);
      expect(writerCode).toMatch(/\bgetSupabase\s*\(/);
    });

    it('uses the approved createUserSupabaseClient helper for user-token writes', () => {
      expect(writerCode).toMatch(/from\s+['"]\.\.\/\.\.\/lib\/supabase-user['"]/);
      expect(writerCode).toMatch(/\bcreateUserSupabaseClient\s*\(/);
    });

    it('does not call createClient( directly (must go via helpers)', () => {
      expect(writerCode).not.toMatch(/\bcreateClient\s*\(/);
    });

    it('exports storeFusionAudit with the documented signature', () => {
      // `(entry: FusionAuditEntry, authToken?: string): Promise<boolean>`
      expect(writerCode).toMatch(
        /export\s+async\s+function\s+storeFusionAudit\s*\(/,
      );
      expect(writerCode).toMatch(/Promise<boolean>/);
    });
  });
});
