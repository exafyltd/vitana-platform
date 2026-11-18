// VTID-05445 (G3): the bare-policy counter. A bare policy uses current_tenant_id() with none of auth.uid(),
// current_user_id(), is_member() or is_tenant_admin() (docs/MULTI-TENANT-PLAN.md section 4, N3). The number is reported,
// never asserted to be 0: that is a WS1 gate.
const TENANT = /\bcurrent_tenant_id\s*\(/i;
const USER_OR_MEMBER = /\b(auth\.uid|current_user_id|is_member|is_tenant_admin)\s*\(/i;

export function isBarePolicy(policy) {
  const text = `${policy.using ?? ''} ${policy.with_check ?? ''}`;
  return TENANT.test(text) && !USER_OR_MEMBER.test(text);
}

/** `tables` is the tables inventory. Allowlist entries `{lint: 'bare-policy', subject: <table>}` take a table out of the count. */
export function countBarePolicies(tables, allowlist) {
  const allowed = new Set(allowlist.entries.filter((e) => e.lint === 'bare-policy').map((e) => e.subject));
  const policies = [];
  let allowedCount = 0;
  let unverified = 0;
  for (const t of tables.rows) {
    if (t.status !== 'verified') { unverified++; continue; }
    for (const p of t.policies) {
      if (!isBarePolicy(p)) continue;
      if (allowed.has(t.name)) allowedCount++;
      else policies.push({ table: t.name, policy: p.name, cmd: p.cmd });
    }
  }
  policies.sort((a, b) => `${a.table}.${a.policy}` < `${b.table}.${b.policy}` ? -1 : 1);
  return {
    count: policies.length,
    allowed: allowedCount,
    unverified_tables: unverified,
    asserted: false,
    caveat: 'A lower bound: skipped migrations and unverified tables are not in the replayed schema.',
    policies,
  };
}
