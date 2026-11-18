// VTID-05764 (plan autonomous-to-staging, lane kiro-aws-access): live drift check of kiro-staging-operator.
//
//   node infra/kiro-access/drift.mjs --from <dir>      reads services.json, clusters.json, secrets.json from <dir>
//
// The workflow writes those files with read-only list calls (aws ecs list-services, rds describe-db-clusters,
// secretsmanager list-secrets) under the read-only role vitana-gha-kiro-access-drift. A finding is: an allow-listed
// staging resource that does not exist or looks like production; a production-looking resource (by name pattern) that
// no explicit Deny covers; or a resource that is neither staging nor production (unclassified, so the allow-list or
// the deny list needs a decision). Exit 1 on any finding; exit 0 otherwise. No write call, no secret value.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, statementsOf } from './lib.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const wild = (p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

export function drift({ services, clusters, secrets }, ids, template) {
  const st = statementsOf(template, 'StagingOperatorRole');
  const R = ids.region; const A = ids.accounts.product;
  const findings = [];
  const svcArn = (n) => `arn:aws:ecs:${R}:${A}:service/${ids.ecs_cluster}/${n}`;
  const prodLike = (n) => ids.production.ecs_service_patterns.some((p) => wild(p).test(n));
  for (const n of ids.staging.ecs_services) {
    if (prodLike(n)) findings.push(`allow-listed staging service ${n} matches a production pattern`);
  }
  for (const n of services) {
    const staging = ids.staging.ecs_services.includes(n);
    if (prodLike(n)) {
      if (evaluate(st, 'ecs:UpdateService', svcArn(n), { explicitOnly: true }) !== 'deny') findings.push(`production service ${n} has no explicit Deny`);
    } else if (!staging) findings.push(`service ${n} is neither on the staging allow-list nor production-named (unclassified)`);
  }
  for (const c of clusters) {
    const arn = `arn:aws:rds:${R}:${A}:cluster:${c}`;
    if (ids.production.rds_clusters.includes(c) || /prod/.test(c)) {
      if (evaluate(st, 'rds:ModifyDBCluster', arn, { explicitOnly: true }) !== 'deny') findings.push(`production cluster ${c} has no explicit Deny`);
    } else if (c !== ids.staging.rds_cluster && evaluate(st, 'rds:ModifyDBCluster', arn) === 'allow') findings.push(`cluster ${c} is writable but not the staging cluster`);
  }
  for (const s of secrets) {
    const arn = `arn:aws:secretsmanager:${R}:${A}:secret:${s}-AbCdEf`;
    const write = evaluate(st, 'secretsmanager:PutSecretValue', arn) === 'allow';
    if (write && !ids.staging.secret_prefixes.some((p) => s.startsWith(p))) findings.push(`secret ${s} is writable but not a staging secret`);
    if ((ids.production.secret_prefixes.some((p) => s.startsWith(p)) || /\/prod\//.test(s)) && evaluate(st, 'secretsmanager:GetSecretValue', arn, { explicitOnly: true }) !== 'deny') findings.push(`production secret ${s} has no explicit Deny`);
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const i = process.argv.indexOf('--from');
  if (i < 0) { console.error('usage: drift.mjs --from <dir>'); process.exit(2); }
  const from = process.argv[i + 1];
  const read = (f) => JSON.parse(fs.readFileSync(path.join(from, f), 'utf8'));
  const ids = JSON.parse(fs.readFileSync(path.join(DIR, 'identifiers.json'), 'utf8'));
  const tpl = JSON.parse(fs.readFileSync(path.join(DIR, 'staging-operator.json'), 'utf8'));
  const services = (read('services.json').serviceArns || []).map((a) => a.split('/').pop());
  const clusters = (read('clusters.json').DBClusters || []).map((c) => c.DBClusterIdentifier);
  const secrets = (read('secrets.json').SecretList || []).map((s) => s.Name);
  const f = drift({ services, clusters, secrets }, ids, tpl);
  for (const x of f) console.log(`drift: ${x}`);
  console.log(`kiro-access drift: ${f.length} finding(s) over ${services.length} services, ${clusters.length} clusters, ${secrets.length} secrets`);
  process.exit(f.length ? 1 : 0);
}
