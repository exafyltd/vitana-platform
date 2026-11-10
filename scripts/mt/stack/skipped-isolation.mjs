// VTID-05520 (mt-guardrails-r2/local-test-stack-pglite): which skipped migrations change tenant resolution or policies
// on a required table that IS present in the stack. Those tables are replayed, but without these definitions, so an
// isolation claim on them runs on non-production tenant resolution and policies. docs/multitenancy/LOCAL-STACK.md lists
// exactly the files this returns, and repo-gate.test.mjs fails when the two disagree.

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const IDENT = '(?:"[^"]+"|\\w+)';
const SCHEMA = '(?:(?:public|"public")\\.)?';
const unq = (s) => s.replace(/"/g, '').toLowerCase();

/** [{ name, body }] for each CREATE [OR REPLACE] FUNCTION; the body runs to the closing dollar-quote tag. */
function functions(sql) {
  const out = [];
  const head = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${SCHEMA}(${IDENT})\\s*\\(`, 'gi');
  for (const m of sql.matchAll(head)) {
    const rest = sql.slice(m.index + m[0].length);
    const open = rest.match(/\$(\w*)\$/);
    let body = rest;
    if (open) {
      const start = open.index + open[0].length;
      const end = rest.indexOf(open[0], start);
      body = rest.slice(open.index, end === -1 ? undefined : end);
    }
    out.push({ name: unq(m[1]), body: body.toLowerCase() });
  }
  return out;
}

/** The reasons (sorted, unique) a migration's SQL touches tenant resolution or policy on one of the present tables. */
export function isolationReasons(rawSql, presentTables) {
  const sql = stripComments(rawSql);
  const present = new Set(presentTables);
  const reasons = new Set();
  const on = new RegExp(`\\b(?:create|alter|drop)\\s+policy\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?${IDENT}\\s+on\\s+${SCHEMA}(${IDENT})`, 'gi');
  for (const m of sql.matchAll(on)) if (present.has(unq(m[1]))) reasons.add(`policy on ${unq(m[1])}`);
  const trg = new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?(?:constraint\\s+)?trigger\\s+${IDENT}[\\s\\S]{0,200}?\\bon\\s+${SCHEMA}(${IDENT})`, 'gi');
  for (const m of sql.matchAll(trg)) if (present.has(unq(m[1]))) reasons.add(`trigger on ${unq(m[1])}`);
  for (const f of functions(sql)) {
    if (/tenant/.test(f.name)) reasons.add(`function ${f.name}`);
    else if (/\b(?:user_tenants|tenants)\b/.test(f.body)) reasons.add(`function ${f.name} (reads or writes tenant membership)`);
  }
  return [...reasons].sort();
}

/** [{ file, reasons }] for every skip that has at least one reason. */
export function findIsolationGaps(skips, presentTables, readMigration) {
  const out = [];
  for (const s of skips) {
    const reasons = isolationReasons(readMigration(s.file), presentTables);
    if (reasons.length) out.push({ file: s.file, reasons });
  }
  return out;
}
