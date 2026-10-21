/**
 * VTID-04860 — the token is called VTNA, never "VTN".
 *
 * Owner directive (2026-10-03). The wallet currency was renamed VTN → VTNA in
 * October 2025, but the old name kept surviving in push copy, the knowledge
 * base Vitana answers from, and docs. This guard fails the build if the bare
 * word "VTN" comes back anywhere members or Vitana can read it.
 *
 * Not covered on purpose:
 *   - supabase/migrations/** written before this change (applied history,
 *     never edited in place — including the original VTN → VTNA rename);
 *   - docs/validation/** (recorded test output, historical evidence);
 *   - identifiers such as vtn_wallets / vtn_reward / payments-wallet-vtn
 *     (lowercase, not shown to members);
 *   - ticket serial numbers "VTN-<digits>" (not the token).
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');

// Bare uppercase word VTN; not VTNA, not vtn_*, not a "VTN-<digit>" serial.
const BARE_VTN = /(?<![A-Za-z0-9_])VTN(?![A-Za-z0-9_])(?!-\d)/;

const SCANNED_ROOTS = [
  'services/gateway/src',
  'services/openclaw-bridge/src',
  'docs/knowledge-base',
  'docs/autopilot-automations',
  'kb',
  'second-brain/wiki',
  'scripts/kb-seed.sql',
];

const TEXT_EXT = new Set(['.ts', '.js', '.json', '.md', '.sql', '.txt']);

function walk(rel: string, out: string[]): void {
  const abs = path.join(REPO_ROOT, rel);
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isFile()) {
    if (TEXT_EXT.has(path.extname(abs))) out.push(rel);
    return;
  }
  for (const entry of fs.readdirSync(abs)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    walk(path.join(rel, entry), out);
  }
}

describe('VTID-04860: the token is VTNA', () => {
  it('no member- or Vitana-readable source uses the bare word "VTN"', () => {
    const files: string[] = [];
    for (const root of SCANNED_ROOTS) walk(root, files);
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const rel of files) {
      const lines = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (BARE_VTN.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the diary-streak push says VTNA', () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, 'services/gateway/src/services/diary-streak-celebrator.ts'),
      'utf8',
    );
    expect(src).toContain('VTNA credited');
    expect(BARE_VTN.test(src)).toBe(false);
  });

  it('a migration renames VTN → VTNA in the live knowledge base, whole word only', () => {
    const migDir = path.join(REPO_ROOT, 'supabase/migrations');
    const file = fs
      .readdirSync(migDir)
      .find((f) => f.endsWith('_vtid_04860_knowledge_docs_vtna_name.sql'));
    expect(file).toBeDefined();
    const sql = fs.readFileSync(path.join(migDir, file as string), 'utf8');
    expect(sql).toMatch(/UPDATE public\.knowledge_docs/);
    // word boundaries keep VTNA and vtn_* identifiers untouched; serials skipped
    expect(sql).toContain("'\\mVTN\\M(?!-[0-9])', 'VTNA'");
    expect(sql).not.toMatch(/\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
  });
});
