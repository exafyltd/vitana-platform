/**
 * Entry point of the delivery loop rehearsal: builds the GitLab transport, runs it, writes the report.
 *
 *   npx tsx scripts/delivery-loop/main.ts <output dir>
 *
 * Transport: GITLAB_API_URL + GITLAB_API_TOKEN (a PRIVATE-TOKEN), or, in the Kiro sandbox, the sandbox's own GitLab proxy
 * (GITLAB_REHEARSAL_VIA=kiro-sandbox), whose credentials come from git's credential helper and are never printed.
 */
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runRehearsal } from './run-rehearsal';
import type { RehearsalTransport } from './rehearse';

function transportFromEnv(): RehearsalTransport {
  if (process.env.GITLAB_REHEARSAL_VIA === 'kiro-sandbox') {
    const host = 'us-east-1.gateway.connections.autonomous-agents.kiro.dev';
    const envId = execSync(`git config --global --get 'http.https://${host}/.extraheader' | sed 's/^environmentId: *//'`).toString().trim();
    const cred = execSync(`printf 'protocol=https\\nhost=${host}\\n\\n' | git credential fill 2>/dev/null`).toString();
    const user = /username=(.*)/.exec(cred)?.[1] ?? '';
    const pass = /password=(.*)/.exec(cred)?.[1] ?? '';
    const basic = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    return {
      baseUrl: `https://${host}/gitlab/api/v4`,
      token: 'placeholder-the-sandbox-proxy-authenticates-by-basic-auth',
      headers: { Authorization: basic, environmentId: envId },
      fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), Authorization: basic, environmentId: envId } }),
    };
  }
  const baseUrl = process.env.GITLAB_API_URL;
  const token = process.env.GITLAB_API_TOKEN;
  if (!baseUrl || !token) throw new Error('set GITLAB_API_URL and GITLAB_API_TOKEN (or GITLAB_REHEARSAL_VIA=kiro-sandbox)');
  return { baseUrl, token, fetch };
}

(async () => {
  const out = process.argv[2];
  if (!out) throw new Error('usage: main.ts <output dir>');
  mkdirSync(out, { recursive: true });
  const runId = (process.env.REHEARSAL_RUN_ID ?? Math.random().toString(36).slice(2, 9)).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'run0000';
  const t = transportFromEnv();
  const { steps, ledger, left, log, artifacts } = await runRehearsal(t, runId);

  const pass = steps.filter((s) => s.ok).length;
  const report = [
    `# Delivery loop rehearsal against the real GitLab (${new Date().toISOString()})`,
    `run id: ${runId}   project: vitana/rehearsal   steps: ${pass}/${steps.length} passed`,
    '',
    'REAL: the GitLab REST client, the engine, the project, its issues and label events, its merge request pipelines, its runner and job logs.',
    'STAND-INS: the OASIS ledger (in memory), the executor (a labelled stub worker that pushes a fix), the reviewer (a fixed verdict), the memory (a recorder).',
    '',
    ...steps.map((s) => `${s.ok ? 'PASS' : 'FAIL'}  ${s.name}\n      ${s.detail}`),
    '',
    `Left behind on GitLab after cleanup: ${left.length === 0 ? 'nothing' : left.join(', ')}`,
    '',
    `Ledger rows written by the loop (${ledger.rows.length}), by topic:`,
    ...Object.entries(ledger.rows.reduce<Record<string, number>>((m, r) => ((m[r.topic] = (m[r.topic] ?? 0) + 1), m), {})).sort().map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`),
    '',
    `GitLab writes made by the rehearsal itself (${log.filter((l) => !l.startsWith('GET')).length}):`,
    ...log.filter((l) => !l.startsWith('GET')).map((l) => `  ${l}`),
  ].join('\n');
  writeFileSync(join(out, 'rehearsal-report.txt'), report + '\n');
  for (const [name, text] of Object.entries(artifacts)) writeFileSync(join(out, name), text + '\n');
  writeFileSync(join(out, 'ledger-rows.json'), JSON.stringify(ledger.rows.map((r) => ({ topic: r.topic, status: r.status, message: r.message, metadata: r.metadata })), null, 1));
  console.log('\n' + report);
  process.exit(pass === steps.length && left.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('rehearsal failed:', e instanceof Error ? e.message : e);
  process.exit(2);
});
