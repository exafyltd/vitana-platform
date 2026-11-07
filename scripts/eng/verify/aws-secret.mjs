#!/usr/bin/env node
// VTID-05552 (agentic-delivery/verify-on-gitlab) — read one Secrets Manager secret with a GitLab ID token
// (plan agentic-delivery §7: roles gl-verify and gl-record, one audience per role; no AWS key on the GitLab side).
//
//   node aws-secret.mjs --token-env <ID token variable> --role-arn <arn> --secret-id <name> --out <file> [--region eu-central-1]
//
// The job's ID token buys 15-minute credentials for the role (STS AssumeRoleWithWebIdentity, an unsigned call), which
// read the secret (Secrets Manager GetSecretValue, Signature Version 4). The SecretString goes to --out with mode 0600;
// nothing secret is printed. Dependency-free, so the jobs run on the Node 20 job image with nothing installed. Refuses
// any account but 472838866351 and any region but eu-central-1 (CLAUDE.md IF–THEN 11) before it calls AWS.
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCOUNT = '472838866351';
const REGION = 'eu-central-1';
const ROLE_RE = new RegExp(`^arn:aws:iam::${ACCOUNT}:role/[\\w+=,.@/-]{1,128}$`);

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s, 'utf8').digest();

/** AWS Signature Version 4 for one request (headers: name → value; host is added and signed). */
export function signV4({ method, host, path = '/', query = '', headers = {}, body = '', region, service, accessKeyId, secretAccessKey, amzDate }) {
  const date = amzDate.slice(0, 8);
  const canon = { host };
  for (const [k, v] of Object.entries(headers)) canon[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(canon).sort();
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, path, query, names.map((n) => `${n}:${canon[n]}\n`).join(''), signedHeaders, sha256hex(body)].join('\n');
  const canonicalRequestHash = sha256hex(canonicalRequest);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, canonicalRequestHash].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
  return {
    canonicalRequestHash,
    signature,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

const xmlText = (xml, tag) => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') : null;
};
const amzDateOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The SecretString of `secretId`, read with `roleArn` assumed through the GitLab ID token `token`. */
export async function readSecret({ token, roleArn, secretId, region = REGION, sessionName, fetchImpl = fetch, now = Date.now }) {
  if (!ROLE_RE.test(roleArn || '')) throw new Error(`role "${roleArn}" is not an IAM role of account ${ACCOUNT} (CLAUDE.md IF–THEN 11)`);
  if (region !== REGION) throw new Error(`region "${region}" is not ${REGION} (CLAUDE.md IF–THEN 11)`);
  if (!token) throw new Error('no ID token');
  if (!secretId) throw new Error('no secret id');
  const sts = await fetchImpl(`https://sts.${region}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: new URLSearchParams({
      Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15', RoleArn: roleArn,
      RoleSessionName: String(sessionName || 'gitlab-ci').replace(/[^\w+=,.@-]/g, '-').slice(0, 64),
      WebIdentityToken: token, DurationSeconds: '900',
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const stsText = await sts.text();
  if (!sts.ok) throw new Error(`assume ${roleArn}: HTTP ${sts.status} ${xmlText(stsText, 'Code') || ''} ${xmlText(stsText, 'Message') || ''}`.trim());
  const accessKeyId = xmlText(stsText, 'AccessKeyId');
  const secretAccessKey = xmlText(stsText, 'SecretAccessKey');
  const sessionToken = xmlText(stsText, 'SessionToken');
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error(`assume ${roleArn}: no credentials in the STS answer`);

  const host = `secretsmanager.${region}.amazonaws.com`;
  const body = JSON.stringify({ SecretId: secretId });
  const amzDate = amzDateOf(now());
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-date': amzDate,
    'x-amz-security-token': sessionToken,
    'x-amz-target': 'secretsmanager.GetSecretValue',
  };
  const { authorization } = signV4({ method: 'POST', host, path: '/', query: '', headers, body, region, service: 'secretsmanager', accessKeyId, secretAccessKey, amzDate });
  const sm = await fetchImpl(`https://${host}/`, { method: 'POST', headers: { ...headers, authorization }, body, signal: AbortSignal.timeout(20_000) });
  const smText = await sm.text();
  let json = {};
  try { json = JSON.parse(smText); } catch { json = {}; }
  if (!sm.ok) throw new Error(`read ${secretId}: HTTP ${sm.status} ${json.__type || ''} ${json.Message || json.message || ''}`.trim());
  if (typeof json.SecretString !== 'string') throw new Error(`read ${secretId}: no SecretString (binary secrets are not supported)`);
  return json.SecretString;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[\w-]+$/.test(argv[i] || '')) throw new Error(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

async function main(argv) {
  const a = parseArgs(argv);
  for (const k of ['token-env', 'role-arn', 'secret-id', 'out']) if (!a[k]) throw new Error(`--${k} is required`);
  const token = process.env[a['token-env']];
  if (!token) throw new Error(`${a['token-env']} is empty: the job declares no ID token of that name (id_tokens in the template)`);
  const secret = await readSecret({
    token, roleArn: a['role-arn'], secretId: a['secret-id'], region: a.region || process.env.AWS_REGION || REGION,
    sessionName: `gitlab-${process.env.CI_PROJECT_ID || 'p'}-${process.env.CI_JOB_ID || 'j'}`,
  });
  const out = resolve(a.out);
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(out, secret, { mode: 0o600 });
  console.log(`[aws-secret] read ${a['secret-id']} with ${a['role-arn'].split('/').pop()} into ${out} (${Buffer.byteLength(secret)} bytes)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`[aws-secret] ${e.message}`);
    process.exit(1);
  });
}
