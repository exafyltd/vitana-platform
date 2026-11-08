// VTID-05445 (G1): readers for the inventories. The catalog reader takes a PGlite database (the VTID-05520 stack); the
// scanners read source trees and migration text. Pure functions, no writes.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const posix = (p) => p.split(sep).join('/');
const SKIP_DIR = /(^|\/)(node_modules|dist|build|coverage|\.git)(\/|$)/;
const byStr = (...keys) => (a, b) => {
  for (const k of keys) {
    const x = String(a[k] ?? ''); const y = String(b[k] ?? '');
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

// ---- catalog (schema public only) -------------------------------------------------------------------------------

/** Who may execute: 'public' | 'anon' | 'authenticated' (service_role and owners are not callers we lint). */
export function executableBy(proacl) {
  const entries = proacl && proacl.length ? proacl : ['=X/owner'];
  const out = new Set();
  for (const e of entries) {
    const eq = e.indexOf('=');
    const grantee = e.slice(0, eq);
    const privs = e.slice(eq + 1).split('/')[0];
    if (!privs.includes('X')) continue;
    if (grantee === '') out.add('public');
    else if (grantee === 'anon' || grantee === 'authenticated') out.add(grantee);
  }
  return [...out].sort();
}

const CALLER_CHECK = /\b(auth\.uid|auth\.jwt|auth\.role|current_user_id|is_member|is_tenant_admin)\s*\(|request\.jwt/i;

export async function readCatalog(db) {
  const tables = (await db.query(`
    SELECT c.relname AS name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
           (a.attnum IS NOT NULL) AS has_tenant_id, (a.attnum IS NOT NULL AND NOT a.attnotnull) AS tenant_id_nullable
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname`)).rows;
  const pol = (await db.query(`
    SELECT tablename, policyname, cmd, permissive, roles::text AS roles, qual, with_check
      FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`)).rows;
  const policiesBy = new Map();
  for (const p of pol) {
    if (!policiesBy.has(p.tablename)) policiesBy.set(p.tablename, []);
    policiesBy.get(p.tablename).push({
      name: p.policyname,
      cmd: p.cmd,
      permissive: p.permissive === 'PERMISSIVE' || p.permissive === true,
      roles: String(p.roles).replace(/^\{|\}$/g, '').split(',').filter(Boolean).sort(),
      using: p.qual ?? null,
      with_check: p.with_check ?? null,
    });
  }
  const fns = (await db.query(`
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args, p.prosecdef AS security_definer,
           p.proconfig::text AS proconfig, p.prosrc AS body, p.proacl::text AS proacl, p.prokind
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     ORDER BY p.proname, 2`)).rows;
  const pub = await db.query(`SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'`);
  const publication = pub.rows.length
    ? (await db.query(`SELECT tablename FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename)
    : [];
  return {
    tables: tables.map((t) => ({
      name: t.name,
      rls_enabled: !!t.rls_enabled,
      rls_forced: !!t.rls_forced,
      has_tenant_id: !!t.has_tenant_id,
      tenant_id_nullable: t.has_tenant_id ? !!t.tenant_id_nullable : null,
      policies: policiesBy.get(t.name) ?? [],
    })),
    functions: fns.map((f) => ({
      name: f.name,
      args: f.args,
      kind: f.prokind === 'p' ? 'procedure' : 'function',
      security_definer: !!f.security_definer,
      search_path_set: /search_path=/.test(f.proconfig ?? ''),
      executable_by: executableBy(parseAcl(f.proacl)),
      caller_check: CALLER_CHECK.test(f.body ?? ''),
    })),
    publication,
  };
}

/** `{=X/postgres,anon=X/postgres}` -> ['=X/postgres', 'anon=X/postgres']; null -> null (the default ACL: PUBLIC may execute). */
function parseAcl(text) {
  if (text == null) return null;
  const inner = String(text).replace(/^\{|\}$/g, '');
  return inner ? inner.split(',').map((s) => s.replace(/^"|"$/g, '')) : [];
}

// ---- source trees -----------------------------------------------------------------------------------------------

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (SKIP_DIR.test(posix(p))) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(e.name) && !/\.(test|spec)\.(ts|js)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const ROUTE_RE = /\b(?:router|app)\.(get|post|put|patch|delete|all)\(\s*(['"`])((?:(?!\2).)*)\2(.*)$/;
const AUTH_NAME = /auth|guard|verify|require|admin|permission|role/i;

/** Middleware names written between the path and the handler on the same line. Multi-line registrations give []. */
export function middlewareOf(rest) {
  const head = rest.replace(/^\s*,\s*/, '').split(/\(|=>/)[0];
  return head.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$.]*$/.test(s) && s !== 'async' && s !== 'function');
}

export function scanRoutes(dir, repoRoot) {
  const rows = [];
  for (const file of walk(dir)) {
    const rel = posix(relative(repoRoot, file));
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = ROUTE_RE.exec(line);
      if (!m) continue;
      const middleware = middlewareOf(m[4]);
      rows.push({ file: rel, method: m[1].toUpperCase(), path: m[3], middleware, auth_middleware: middleware.some((n) => AUTH_NAME.test(n)) });
    }
  }
  return rows.sort((a, b) => byStr('file', 'path', 'method')(a, b) || (a.middleware.join() < b.middleware.join() ? -1 : a.middleware.join() > b.middleware.join() ? 1 : 0));
}

export function parseVerifyJwt(text) {
  const out = new Map();
  const re = /\[functions\.([^\]]+)\]([\s\S]*?)(?=\n\[|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const v = /verify_jwt\s*=\s*(true|false)/.exec(m[2]);
    if (v) out.set(m[1].replace(/^"|"$/g, ''), v[1] === 'true');
  }
  return out;
}

export function scanEdgeFunctions(dir, repoRoot) {
  const cfgPath = [join(dir, 'config.toml'), join(dir, '..', 'config.toml')].find((p) => existsSync(p));
  const verify = cfgPath ? parseVerifyJwt(readFileSync(cfgPath, 'utf8')) : new Map();
  const rows = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { /* none */ }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue;
    const entry = ['index.ts', 'index.tsx', 'index.js', 'main.ts'].find((f) => existsSync(join(dir, e.name, f)));
    if (!entry) continue;
    const file = join(dir, e.name, entry);
    const src = readFileSync(file, 'utf8');
    rows.push({
      name: e.name,
      file: posix(relative(repoRoot, file)),
      reads_authorization_header: /authorization/i.test(src),
      uses_service_role: /service_role/i.test(src),
      verify_jwt: verify.has(e.name) ? verify.get(e.name) : null,
    });
  }
  return rows.sort(byStr('name'));
}

// ---- migration text (the storage schema and some publications do not replay on PGlite) -------------------------------

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const unquote = (s) => s.trim().replace(/^"|"$/g, '');
const norm = (s) => s.replace(/\s+/g, ' ').trim();

export function scanMigrationText(dir) {
  let files = [];
  try { files = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.sql')).map((d) => d.name).sort(); } catch { /* none */ }
  const realtime = new Set();
  const buckets = new Map();
  const policies = new Map();
  for (const file of files) {
    const sql = stripComments(readFileSync(join(dir, file), 'utf8'));
    const events = [];
    let m;
    const addRe = /ALTER\s+PUBLICATION\s+supabase_realtime\s+(ADD|DROP)\s+TABLE\s+(?:ONLY\s+)?([^;]+);/gi;
    while ((m = addRe.exec(sql))) {
      for (const raw of m[2].split(',')) {
        const t = unquote(raw.replace(/^\s*ONLY\s+/i, '')).replace(/^public\./, '').replace(/"/g, '');
        if (t) events.push({ at: m.index, kind: m[1].toUpperCase() === 'ADD' ? 'rt+' : 'rt-', t });
      }
    }
    const bucketRe = /INSERT\s+INTO\s+storage\.buckets\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?)(?:ON\s+CONFLICT|;)/gi;
    while ((m = bucketRe.exec(sql))) {
      const cols = m[1].split(',').map((c) => unquote(c).toLowerCase());
      const pubIdx = cols.indexOf('public');
      const idIdx = cols.indexOf('id');
      const tupleRe = /\(([^()]*)\)/g;
      let tm;
      while ((tm = tupleRe.exec(m[2]))) {
        const vals = tm[1].split(',').map((v) => v.trim());
        const id = vals[idIdx < 0 ? 0 : idIdx]?.replace(/^'|'$/g, '');
        if (!id) continue;
        const pv = pubIdx >= 0 ? vals[pubIdx]?.toLowerCase() : undefined;
        events.push({ at: m.index, kind: 'bucket', id, public: pv === 'true' ? true : pv === 'false' ? false : null });
      }
    }
    const polRe = /CREATE\s+POLICY\s+("[^"]+"|[\w$]+)\s+ON\s+storage\.objects\b([^;]*);/gi;
    while ((m = polRe.exec(sql))) {
      const rest = norm(m[2]);
      const cmd = /\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i.exec(rest);
      events.push({ at: m.index, kind: 'pol+', name: unquote(m[1]), cmd: cmd ? cmd[1].toUpperCase() : 'ALL', expression: rest });
    }
    const dropRe = /DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?("[^"]+"|[\w$]+)\s+ON\s+storage\.objects\b/gi;
    while ((m = dropRe.exec(sql))) events.push({ at: m.index, kind: 'pol-', name: unquote(m[1]) });
    events.sort((a, b) => a.at - b.at);
    for (const ev of events) {
      if (ev.kind === 'rt+') realtime.add(ev.t);
      else if (ev.kind === 'rt-') realtime.delete(ev.t);
      else if (ev.kind === 'bucket') { if (!buckets.has(ev.id)) buckets.set(ev.id, { id: ev.id, public: ev.public, source: 'migrations', file }); }
      else if (ev.kind === 'pol+') policies.set(ev.name, { name: ev.name, cmd: ev.cmd, expression: ev.expression, source: 'migrations', file });
      else if (ev.kind === 'pol-') policies.delete(ev.name);
    }
  }
  return {
    realtime: [...realtime].sort(),
    buckets: [...buckets.values()].sort(byStr('id')),
    storage_policies: [...policies.values()].sort(byStr('name')),
  };
}
