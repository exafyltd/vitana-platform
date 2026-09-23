/**
 * VTID-04345 — the morning health check judges the memory system daily.
 *
 * Pins: check 21 calls the ci_memory_health() RPC, the scheduled-workflow
 * self-audit stays LAST (it counts the FAIL rows of every check before it)
 * and is renumbered 22, TOTAL_CHECKS matches, and the RPC migration is
 * service_role-only.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml'), 'utf8');
const MIG = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260923140000_vtid_04345_ci_memory_health.sql'),
  'utf8',
);

describe('VTID-04345 morning memory check', () => {
  it('check 21 calls ci_memory_health over PostgREST', () => {
    const i = WF.indexOf("- name: '21. Memory system health (VTID-04345)'");
    expect(i).toBeGreaterThan(-1);
    const step = WF.slice(i, WF.indexOf('- name:', i + 10));
    expect(step).toContain('/rest/v1/rpc/ci_memory_health');
    expect(step).toContain('| 21 | Memory system health |');
  });

  it('the self-audit stays the last numbered check and TOTAL_CHECKS matches', () => {
    const memIdx = WF.indexOf("'21. Memory system health");
    const selfIdx = WF.indexOf("- name: '22. Scheduled-workflow self-audit'");
    expect(selfIdx).toBeGreaterThan(memIdx);
    expect(WF).toContain('| 22 | Scheduled-workflow self-audit |');
    expect(WF).toMatch(/TOTAL_CHECKS: 22\n/);
    expect(WF).not.toContain("- name: '21. Scheduled-workflow self-audit'");
  });

  it('judges the failure shapes that went unnoticed before', () => {
    for (const signal of ['embedding-coverage', 'AP-0910-last-run', 'memory-never-reached-prompt', 'no-memory-writes-24h', 'preferred_language-churn']) {
      expect(WF).toContain(signal);
    }
  });

  it('the RPC is service_role only and returns counts, not content', () => {
    expect(MIG).toContain('SECURITY DEFINER');
    expect(MIG).toContain('REVOKE ALL ON FUNCTION public.ci_memory_health() FROM PUBLIC, anon, authenticated;');
    expect(MIG).toContain('GRANT EXECUTE ON FUNCTION public.ci_memory_health() TO service_role;');
    expect(MIG).not.toMatch(/'content'|'fact_value'|\bcontent,\s*$/m);
  });
});
