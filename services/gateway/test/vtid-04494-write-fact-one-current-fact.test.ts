/**
 * VTID-04494: write_fact() keeps exactly one current fact per
 * (tenant, user, entity, fact_key).
 *
 * The concurrency behaviour was proven against a real Postgres 16 (see
 * docs/validation/VTID-04494/commands.log); this suite pins the SQL shape so
 * a later rewrite cannot bring back the two defects.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SQL = readFileSync(
  join(__dirname, '../../../supabase/migrations/20260924150000_vtid_04494_write_fact_one_current_fact.sql'),
  'utf8',
);
const code = SQL.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
const body = code.slice(code.indexOf('AS $function$'), code.indexOf('$function$;'));

describe('VTID-04494 write_fact one current fact', () => {
  it('serialises writers per key with a transaction advisory lock', () => {
    expect(body).toMatch(/pg_advisory_xact_lock\(\s*hashtextextended\(/);
    const lockAt = body.indexOf('pg_advisory_xact_lock');
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(body.indexOf('FROM memory_facts'));
    for (const part of ['p_tenant_id', 'p_user_id', 'p_entity', 'p_fact_key']) {
      expect(body.slice(lockAt, body.indexOf('v_new_fact_id := gen_random_uuid()'))).toContain(part);
    }
  });

  it('no longer skips locked rows', () => {
    expect(body).not.toMatch(/SKIP\s+LOCKED/i);
  });

  it('compares against the newest current row', () => {
    expect(body).toMatch(/ORDER BY extracted_at DESC, id DESC\s+LIMIT 1/);
  });

  it('supersedes every other current row, not one id', () => {
    expect(body).not.toMatch(/WHERE id = v_old_fact_id/);
    const updates = body.match(/UPDATE memory_facts[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u).toMatch(/superseded_by IS NULL/);
      expect(u).toMatch(/AND id <> v_(old|new)_fact_id/);
      expect(u).toMatch(/fact_key = p_fact_key/);
      expect(u).toMatch(/entity = p_entity/);
    }
  });

  it('keeps the VTID-04341 same-value skip', () => {
    expect(body).toMatch(/LOWER\(TRIM\(v_old_fact_value\)\) = LOWER\(TRIM\(p_fact_value\)\)/);
    expect(body).toMatch(/_memory_provenance_rank\(p_provenance_source\)\s+<= public\._memory_provenance_rank\(v_old_provenance_source\)/);
    expect(body).toMatch(/RETURN v_old_fact_id;/);
  });

  it('repairs existing duplicates without deleting rows, newest wins', () => {
    const repair = code.slice(code.indexOf('$function$;'));
    expect(repair).toMatch(/PARTITION BY tenant_id, user_id, entity, fact_key\s+ORDER BY extracted_at DESC, id DESC/);
    expect(repair).toMatch(/SET superseded_by = r\.keeper/);
    expect(repair).toMatch(/r\.rn > 1/);
    expect(code).not.toMatch(/DELETE\s+FROM\s+memory_facts/i);
  });

  it('keeps the function signature callers use', () => {
    expect(code).toMatch(/CREATE OR REPLACE FUNCTION public\.write_fact\(\s*p_tenant_id uuid,\s*p_user_id uuid,\s*p_fact_key text,\s*p_fact_value text,\s*p_entity text DEFAULT 'self'::text,\s*p_fact_value_type text DEFAULT 'text'::text,\s*p_provenance_source text DEFAULT 'user_stated'::text,\s*p_provenance_utterance_id uuid DEFAULT NULL::uuid,\s*p_provenance_confidence numeric DEFAULT 0\.90,\s*p_thread_id uuid DEFAULT NULL::uuid\s*\)/);
    expect(code).toMatch(/SECURITY DEFINER/);
  });
});
