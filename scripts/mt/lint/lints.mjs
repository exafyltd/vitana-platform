// VTID-05445 (G2): the five DB lints over the generated inventories, against the owner-tagged allowlist.
// Input is the object of buildInventories() (or the committed JSON). A table that is not verified (not-replayable.txt) is
// reported `unverified` and never passes; the allowlist cannot change that.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countBarePolicies } from './bare-policy.mjs';

export const LINTS = Object.freeze(['nullable-tenant-id', 'missing-tenant-policy', 'definer-without-guard', 'realtime-without-tenant-rls', 'storage-policy']);
const ALLOWLISTED = new Set([...LINTS, 'bare-policy']);
export const ALLOWLIST_FILE = join(dirname(fileURLToPath(import.meta.url)), 'allowlist.json');

const TENANT_POLICY = /tenant|\bis_member\s*\(|\bis_tenant_admin\s*\(/i;
const STORAGE_SCOPE = /\bauth\.uid\s*\(|\bcurrent_user_id\s*\(|\bis_member\s*\(|\bis_tenant_admin\s*\(|tenant/i;

export function validateAllowlist(a) {
  if (!a || a.schema_version !== 1 || !Array.isArray(a.entries)) throw new Error('allowlist.json: needs schema_version 1 and an entries array');
  a.entries.forEach((e, i) => {
    const at = `allowlist.json entry ${i}`;
    if (!ALLOWLISTED.has(e.lint)) throw new Error(`${at}: unknown lint "${e.lint}"`);
    for (const k of ['subject', 'owner', 'reason']) {
      if (typeof e[k] !== 'string' || !e[k].trim()) throw new Error(`${at}: ${k} is required (owner-tagged allowlist)`);
    }
  });
  return a;
}
export const loadAllowlist = (file = ALLOWLIST_FILE) => validateAllowlist(JSON.parse(readFileSync(file, 'utf8')));

const hasTenantRls = (t) => t.rls_enabled && t.policies.some((p) => TENANT_POLICY.test(`${p.using ?? ''} ${p.with_check ?? ''}`));
const fnSubject = (f) => `${f.name}(${f.args})`;

export function runLints(inv, allowlist) {
  validateAllowlist(allowlist);
  const raw = [];
  const unverified = [];
  const verifiedTables = [];
  for (const t of inv.tables.rows) {
    if (t.status !== 'verified') {
      for (const lint of ['nullable-tenant-id', 'missing-tenant-policy']) {
        unverified.push({ lint, subject: t.name, status: 'unverified', reason: t.reason ?? 'not replayable', lanes: t.lanes ?? [] });
      }
      continue;
    }
    verifiedTables.push(t);
    if (t.has_tenant_id && t.tenant_id_nullable) {
      raw.push({ lint: 'nullable-tenant-id', subject: t.name, detail: 'tenant_id is nullable' });
    }
    if (t.has_tenant_id && !hasTenantRls(t)) {
      raw.push({ lint: 'missing-tenant-policy', subject: t.name,
        detail: !t.rls_enabled ? 'row level security is off' : t.policies.length ? 'no policy mentions the tenant' : 'row level security is on with no policy' });
    }
  }
  for (const f of inv.functions.rows) {
    if (f.security_definer && f.executable_by.length > 0 && !f.caller_check) {
      raw.push({ lint: 'definer-without-guard', subject: fnSubject(f), detail: `SECURITY DEFINER, executable by ${f.executable_by.join(', ')}, no caller check in the body` });
    }
  }
  const byName = new Map(verifiedTables.map((t) => [t.name, t]));
  for (const r of inv.realtime_tables.rows) {
    const t = byName.get(r.table);
    if (!t) {
      unverified.push({ lint: 'realtime-without-tenant-rls', subject: r.table, status: 'unverified', reason: r.reason ?? 'not in the replayed schema', lanes: [] });
    } else if (!hasTenantRls(t)) {
      raw.push({ lint: 'realtime-without-tenant-rls', subject: r.table, detail: 'in the realtime publication without a tenant row level security policy' });
    }
  }
  for (const p of inv.buckets.storage_policies) {
    if (!STORAGE_SCOPE.test(p.expression)) {
      raw.push({ lint: 'storage-policy', subject: p.name, detail: `storage.objects ${p.cmd} policy with no user or tenant scoping`, source: p.source, file: p.file });
    }
  }

  const keyOf = (x) => `${x.lint}\u0000${x.subject}`;
  const entries = new Map(allowlist.entries.map((e) => [keyOf(e), e]));
  const findings = [];
  const allowed = [];
  const matched = new Set();
  for (const f of raw) {
    const e = entries.get(keyOf(f));
    if (e) { matched.add(keyOf(f)); allowed.push({ ...f, owner: e.owner, reason: e.reason }); } else findings.push(f);
  }
  for (const u of unverified) if (entries.has(keyOf(u))) matched.add(keyOf(u));
  const stale = allowlist.entries.filter((e) => e.lint !== 'bare-policy' && !matched.has(keyOf(e)));
  const bare = countBarePolicies(inv.tables, allowlist);
  const cmp = (a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
  findings.sort(cmp); allowed.sort(cmp); unverified.sort(cmp);

  const perLint = Object.fromEntries(LINTS.map((l) => [l, findings.filter((f) => f.lint === l).length]));
  return {
    findings, allowed, unverified,
    stale_allowlist: stale,
    bare_policies: bare,
    summary: { findings: findings.length, allowed: allowed.length, unverified: unverified.length, stale_allowlist: stale.length, bare_policies: bare.count, per_lint: perLint },
  };
}
