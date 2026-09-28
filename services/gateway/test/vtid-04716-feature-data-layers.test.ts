/**
 * VTID-04716 / 04717 / 04718 / 04719 / 04720 — the data layers five features
 * declared and never got. Service Health (VTID-04665) showed each one down.
 *
 * These are source contracts on the migrations. The SQL itself was executed
 * against Postgres 16 with Supabase stubs, twice (idempotent), and every
 * function the services call was run as a member; the transcript is in
 * docs/validation/VTID-04716/outputs/.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIG = path.resolve(__dirname, '../../../supabase/migrations');
const read = (prefix: string) => {
  const f = fs.readdirSync(MIG).find((n) => n.startsWith(prefix));
  if (!f) throw new Error(`migration ${prefix} missing`);
  return fs.readFileSync(path.join(MIG, f), 'utf8');
};
const code = (sql: string) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../src', rel), 'utf8');

const autopilot = read('20260928200000_vtid_04716');
const overload = read('20260928200100_vtid_04718');
const taste = read('20260928200200_vtid_04719');
const prefs = read('20260928200300_vtid_04720');
const risk = read('20260928200400_vtid_04717');

describe('Autopilot Prompts (VTID-04716)', () => {
  it('references tenants(tenant_id), the live key — tenants(id) is why it never applied', () => {
    expect(code(autopilot)).not.toContain('tenants(id)');
    expect(code(autopilot)).toContain('REFERENCES public.tenants(tenant_id)');
  });
  it('creates both tables the service reads', () => {
    expect(autopilot).toMatch(/CREATE TABLE IF NOT EXISTS public\.autopilot_prompts \(/);
    expect(autopilot).toMatch(/CREATE TABLE IF NOT EXISTS public\.autopilot_prompt_prefs \(/);
  });
  it('keeps the any-user SECURITY DEFINER helpers away from members', () => {
    const c = code(autopilot);
    expect(c).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.(count_prompts_today|get_user_prompt_prefs)\(UUID, UUID\) TO authenticated/);
    expect(c).toMatch(/REVOKE ALL ON FUNCTION public\.count_prompts_today\(UUID, UUID\) FROM PUBLIC, anon, authenticated/);
    expect(c).toMatch(/REVOKE ALL ON FUNCTION public\.get_user_prompt_prefs\(UUID, UUID\) FROM PUBLIC, anon, authenticated/);
  });
});

describe('tenant resolution for D39 / D51 / preference modeling', () => {
  for (const [name, sql] of [['overload', overload], ['taste', taste], ['preferences', prefs]] as const) {
    it(`${name}: uses caller_tenant_id(), never current_tenant_id() directly`, () => {
      const c = code(sql);
      const body = c.slice(c.indexOf('$fn$;') + 5); // everything after the resolver
      expect(body).not.toContain('public.current_tenant_id()');
      expect(body).toContain('public.caller_tenant_id()');
    });
  }
  it('does not redefine current_tenant_id() (it backs RLS on many other tables)', () => {
    for (const sql of [autopilot, overload, taste, prefs, risk]) {
      expect(code(sql)).not.toMatch(/FUNCTION public\.current_tenant_id\(\)/);
    }
  });
  it('resolver order: explicit context, then app_metadata.active_tenant_id, then membership', () => {
    const c = code(overload);
    const a = c.indexOf('public.current_tenant_id()');
    const b = c.indexOf("'app_metadata' ->> 'active_tenant_id'");
    const m = c.indexOf('FROM public.user_tenants ut');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(m).toBeGreaterThan(b);
  });
});

describe('Overload Detection (VTID-04718)', () => {
  it('overload_patterns has created_at before the index that uses it', () => {
    const c = code(overload);
    const col = c.indexOf('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()', c.indexOf('CREATE TABLE IF NOT EXISTS public.overload_patterns'));
    const idx = c.indexOf('idx_overload_patterns_user');
    expect(col).toBeGreaterThan(-1);
    expect(col).toBeLessThan(idx);
  });
  it('defines the functions the health route and repository use', () => {
    for (const fn of ['overload_detect', 'overload_get_detections', 'overload_compute_baselines', 'overload_get_baselines', 'overload_record_pattern', 'overload_dismiss', 'overload_explain']) {
      expect(overload).toContain(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    }
  });
});

describe('Taste Alignment (VTID-04719)', () => {
  it('defines taste_profile_get and taste_reaction_record', () => {
    expect(taste).toContain('CREATE OR REPLACE FUNCTION public.taste_profile_get(');
    expect(taste).toContain('CREATE OR REPLACE FUNCTION public.taste_reaction_record(');
  });
  it('audit pagination runs in a subquery (ORDER BY on the aggregate is rejected by Postgres)', () => {
    expect(code(taste)).toMatch(/FROM \(\s*SELECT \*\s*FROM public\.taste_alignment_audit[\s\S]*?LIMIT p_limit\s*OFFSET p_offset\s*\) a;/);
  });
});

describe('Preference modeling (VTID-04720)', () => {
  it('never creates, alters, grants on or policies the live settings table public.user_preferences', () => {
    expect(code(prefs)).not.toMatch(/public\.user_preferences\b(?!_)/);
    expect(code(prefs)).toContain('CREATE TABLE IF NOT EXISTS public.user_explicit_preferences (');
  });
  it('audit pagination runs in a subquery', () => {
    expect(code(prefs)).toMatch(/FROM \(\s*SELECT \*\s*FROM public\.user_preference_audit[\s\S]*?LIMIT p_limit\s*OFFSET p_offset\s*\) a;/);
  });
  it('the health route declares the new table', () => {
    expect(src('routes/user-preferences.ts')).toContain("{ table: 'user_explicit_preferences' }");
  });
});

describe('Risk Mitigation (VTID-04717)', () => {
  it('has every column the engine writes', () => {
    const engine = src('services/d49-risk-mitigation-engine.ts');
    const insertCols = ['tenant_id', 'user_id', 'risk_window_id', 'domain', 'confidence', 'suggested_adjustment',
      'why_this_helps', 'effort_level', 'source_signals', 'precedent_type', 'disclaimer', 'status', 'expires_at',
      'generated_by_version', 'input_hash', 'suggestion_hash', 'dismissed_at', 'dismiss_reason', 'acknowledged_at', 'updated_at'];
    for (const col of insertCols) {
      expect(engine).toContain(`${col}:`);
      expect(risk).toMatch(new RegExp(`\\n\\s+${col} [A-Z]`));
    }
  });
  it('domain and status checks match the zod enums', () => {
    expect(risk).toContain("domain IN ('sleep','nutrition','movement','mental','routine','social')");
    expect(risk).toContain("status IN ('active','dismissed','acknowledged','expired','superseded')");
  });
  it('members read and change only their own rows, and write only into their own tenant', () => {
    const c = code(risk);
    expect(c).toMatch(/risk_mitigations_select_own[\s\S]*?USING \(user_id = auth\.uid\(\)\)/);
    expect(c).toMatch(/risk_mitigations_insert_own[\s\S]*?user_id = auth\.uid\(\)\s*AND public\.caller_is_tenant_member\(tenant_id\)/);
  });
  it('does not attach the notification trigger (a product decision, not a side effect)', () => {
    expect(code(risk)).not.toMatch(/CREATE TRIGGER/);
  });
});
