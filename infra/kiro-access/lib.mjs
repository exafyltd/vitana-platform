// VTID-05764 (plan autonomous-to-staging, lane kiro-aws-access): a small IAM evaluator and the static drift check
// for the Kiro role templates. It models what these templates use: Allow/Deny, Action/NotAction, Resource/NotResource
// with `*` and `?` wildcards, the StringEquals/StringLike conditions on context keys, Fn::Sub with the pseudo
// parameters, and the AWS managed AdministratorAccess policy. It is a test aid, not a replacement for the IAM policy
// simulator; the live check after apply is `drift.mjs`.

const ACCOUNT_OF = { product: '472838866351', engineering: '841276716213' };

const wild = (pattern) => new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
const arr = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

/** Resolve the intrinsic functions these templates use into plain strings. */
export function resolve(v, account, region = 'eu-central-1', params = {}) {
  if (Array.isArray(v)) return v.map((x) => resolve(x, account, region, params));
  if (v && typeof v === 'object') {
    if ('Fn::Sub' in v) {
      const s = Array.isArray(v['Fn::Sub']) ? v['Fn::Sub'][0] : v['Fn::Sub'];
      return s.replace(/\$\{([^}]+)\}/g, (_, k) => ({ 'AWS::AccountId': account, 'AWS::Region': region, 'AWS::Partition': 'aws' }[k] ?? params[k] ?? `\${${k}}`));
    }
    if ('Ref' in v) return params[v.Ref] ?? `\${${v.Ref}}`;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, account, region, params)]));
  }
  return v;
}

/** The effective identity-policy statements of one resource (role, user or managed policy) of a template. */
export function statementsOf(template, name, params = {}) {
  const account = ACCOUNT_OF[template.Metadata?.Account];
  if (!account) throw new Error(`template Metadata.Account must be one of ${Object.keys(ACCOUNT_OF)}`);
  const r = template.Resources?.[name];
  if (!r) throw new Error(`no resource ${name}`);
  const p = r.Properties || {};
  const out = [];
  if (r.Type === 'AWS::IAM::ManagedPolicy') out.push(...arr(p.PolicyDocument?.Statement));
  for (const pol of arr(p.Policies)) out.push(...arr(pol.PolicyDocument?.Statement));
  for (const m of arr(p.ManagedPolicyArns)) {
    if (m === 'arn:aws:iam::aws:policy/AdministratorAccess') out.push({ Sid: 'AdministratorAccess', Effect: 'Allow', Action: '*', Resource: '*' });
    else if (m && typeof m === 'object' && m.Ref && template.Resources[m.Ref]) out.push(...arr(template.Resources[m.Ref].Properties.PolicyDocument.Statement));
  }
  const defaults = Object.fromEntries(Object.entries(template.Parameters || {}).map(([k, v]) => [k, v.Default]));
  return resolve(out, account, 'eu-central-1', { ...defaults, ...params });
}

function condOk(cond, context) {
  if (!cond) return true;
  for (const [op, kv] of Object.entries(cond)) {
    for (const [k, want] of Object.entries(kv)) {
      const have = context[k];
      if (have === undefined) return false;
      const ws = arr(want);
      if (op === 'StringEquals' && !ws.includes(have)) return false;
      else if (op === 'StringLike' && !ws.some((w) => wild(w).test(have))) return false;
      else if (op === 'StringNotEquals' && ws.includes(have)) return false;
      else if (!['StringEquals', 'StringLike', 'StringNotEquals'].includes(op)) return false;
    }
  }
  return true;
}

function matches(s, action, arn, context) {
  const actOk = s.NotAction ? !arr(s.NotAction).some((a) => wild(a).test(action)) : arr(s.Action).some((a) => wild(a).test(action));
  if (!actOk) return false;
  const resOk = s.NotResource ? !arr(s.NotResource).some((r) => wild(r).test(arn)) : arr(s.Resource).some((r) => wild(r).test(arn));
  return resOk && condOk(s.Condition, context);
}

/**
 * 'allow' | 'deny' for one request. With `explicitOnly`, 'deny' only when an explicit Deny matches, else 'none'.
 */
export function evaluate(statements, action, arn, { context = {}, explicitOnly = false } = {}) {
  const hit = (eff) => statements.some((s) => s.Effect === eff && matches(s, action, arn, context));
  if (hit('Deny')) return 'deny';
  if (explicitOnly) return 'none';
  return hit('Allow') ? 'allow' : 'deny';
}

const READ = /^[a-z0-9-]+:(Describe|List|Get|BatchGet|Filter|Lookup|Search|Start(Query)$)|^logs:(StartQuery|GetQueryResults|FilterLogEvents)$/;
const isRead = (a) => READ.test(a) && !/^secretsmanager:GetSecretValue$/.test(a);

/** Static drift: every Allow statement with a non-read action names only staging resources (or is tag-scoped). */
export function staticDrift(template, ids, name = 'StagingOperatorRole') {
  const p = ids.production;
  const prodRes = [
    ...p.ecs_service_patterns.map((x) => `arn:aws:ecs:*:*:service/${ids.ecs_cluster}/${x}`),
    ...p.rds_clusters.flatMap((c) => [`arn:aws:rds:*:*:cluster:${c}`, `arn:aws:rds:*:*:db:${c}*`]),
    ...p.rds_proxies.map((x) => `arn:aws:rds:*:*:db-proxy:${x}`),
    ...p.load_balancers.map((x) => `arn:aws:elasticloadbalancing:*:*:*/app/${x}/*`),
    ...p.secret_prefixes.map((x) => `arn:aws:secretsmanager:*:*:secret:${x}*`),
    ...p.kms_keys,
  ];
  const sample = (pat) => pat.replace(/^(arn:aws:[a-z-]+):\*:\*:/, `$1:${ids.region}:${ids.accounts.product}:`).replace(/\*/g, 'x');
  const findings = [];
  for (const s of statementsOf(template, name)) {
    if (s.Effect !== 'Allow') continue;
    const acts = arr(s.Action);
    const writes = acts.filter((a) => !isRead(a));
    if (!writes.length) continue;
    const tagScoped = s.Condition?.StringEquals?.['aws:ResourceTag/vitana-env'] === 'staging';
    for (const r of arr(s.Resource)) {
      if (r === '*' && !tagScoped && writes.some((a) => a !== 'ecs:RegisterTaskDefinition')) findings.push(`${s.Sid || '?'}: write ${writes.join(',')} on *`);
      if (r === '*') continue;
      for (const pr of prodRes) {
        if (wild(pr).test(r) || wild(r).test(sample(pr))) findings.push(`${s.Sid || '?'}: ${r} matches production ${pr}`);
      }
    }
  }
  return findings;
}
