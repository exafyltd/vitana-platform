// A dry-run transcript of the merge bot against a scratch git repository and a fake GitLab (no network, no token worth the name).
// usage: node dry-run-transcript.mjs <repository root>      The output is the transcript: status, then run --dry-run, then run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] ?? '.');
const { main } = await import(pathToFileURL(path.join(ROOT, 'scripts/eng/gitlab-land.mjs')).href);
const { fakeFetch } = await import(pathToFileURL(path.join(ROOT, 'scripts/eng/testing/fake-fetch.mjs')).href);

const env = { ...process.env, GIT_AUTHOR_NAME: 'builder', GIT_AUTHOR_EMAIL: 'b@test', GIT_COMMITTER_NAME: 'builder', GIT_COMMITTER_EMAIL: 'b@test', GIT_CONFIG_NOSYSTEM: '1' };
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'land-transcript-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const remote = path.join(dir, 'remote.git');
const work = path.join(dir, 'work');
execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote], { env });
execFileSync('git', ['clone', '-q', remote, work], { env, stdio: 'ignore' });
g(work, 'checkout', '-q', '-b', 'main');
const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true }); fs.writeFileSync(path.join(work, f), t); };
const commit = (m) => { g(work, 'add', '-A'); g(work, 'commit', '-q', '-m', m); return g(work, 'rev-parse', 'HEAD'); };
put('README.md', 'demo\n'); put('.kiro/specs/demo/lanes/lane-a.md', '---\nlane: lane-a\n---\n## Log\n'); put('.kiro/specs/demo/lanes/lane-b.md', '---\nlane: lane-b\n---\n## Log\n');
commit('initial'); g(work, 'push', '-q', 'origin', 'main');

const REVIEWER = 'agent:vitana-lane-reviewer (claude-sonnet-5.5)';
const mrs = []; const events = []; const pipelines = []; const merged = new Set();
function lane(name, iid, { review }) {
  g(work, 'checkout', '-q', '-B', `kiro/demo/${name}`, 'origin/main');
  put(`scripts/${name}.mjs`, 'export const x = 1;\n');
  const F = commit(`VTID-05999 (demo/${name}): add the feature\n\nCollab-Session: kiro-exafy-202611050900-aaaa`);
  let head = F;
  if (review) {
    fs.appendFileSync(path.join(work, `.kiro/specs/demo/lanes/${name}.md`), `\n### review\nreview: accept\nhead: ${F}\n`);
    head = commit(`review(demo/${name}): accept\n\nCollab-Session: agent-vitana-lane-reviewer-202611051001-abcd\nCollab-Review: demo/${name}\nCollab-Verdict: accept\nCollab-Reviewer: ${REVIEWER}\nCollab-Reviewed-Head: ${F}`);
    events.push({ author_username: 'agent-reviewer', push_data: { commit_from: F, commit_to: head, commit_count: 1 } });
  }
  g(work, 'push', '-q', 'origin', `kiro/demo/${name}:refs/heads/kiro/demo/${name}`);
  g(remote, 'update-ref', `refs/merge-requests/${iid}/head`, head);
  mrs.push({ iid, title: `VTID-05999 (demo/${name}): add the feature`, description: 'Why: demonstration.', sha: head, source_branch: `kiro/demo/${name}`, target_branch: 'main', draft: false, state: 'opened', created_at: `2026-11-05T09:0${iid % 10}:00Z`, updated_at: '2026-11-05T10:00:00Z' });
  pipelines.push({ id: 900 + iid, sha: head, status: 'success', created_at: '2026-11-05T10:20:00Z' });
}
lane('lane-a', 7, { review: true });
lane('lane-b', 8, { review: false });

const P = '/api/v4/projects/vitana%2Frehearsal';
const f = fakeFetch();
f.route('GET', P, { json: { id: 42, default_branch: 'main' } });
f.route('GET', `${P}/merge_requests`, () => ({ json: mrs.filter((m) => !merged.has(m.iid)) }));
f.route('GET', /\/merge_requests\/\d+$/, (c) => ({ json: { ...mrs.find((m) => m.iid === Number(c.path.split('/').pop())), state: merged.has(Number(c.path.split('/').pop())) ? 'merged' : 'opened' } }));
f.route('GET', `${P}/events`, () => ({ json: events }));
f.route('GET', `${P}/pipelines`, (c) => ({ json: pipelines.filter((p) => p.sha === c.query.sha?.[0]) }));
f.route('GET', /\/pipelines\/\d+\/jobs$/, () => ({ json: [{ id: 1, name: 'unit', status: 'success', allow_failure: false, started_at: '2026-11-05T10:21:00Z' }, { id: 2, name: 'build', status: 'success', allow_failure: false, started_at: '2026-11-05T10:21:00Z' }, { id: 3, name: 'lint', status: 'failed', allow_failure: true, started_at: '2026-11-05T10:21:00Z' }] }));
f.route('GET', /\/merge_requests\/\d+\/notes$/, { json: [] });
f.route('POST', /\/merge_requests\/\d+\/notes$/, { status: 201, json: { id: 1 } });
f.route('PUT', /\/merge_requests\/\d+\/merge$/, (c) => { merged.add(Number(c.path.split('/').at(-2))); return { json: { state: 'merged' } }; });

const tokenFile = path.join(dir, 'bot-land-token');
fs.writeFileSync(tokenFile, 'fixture-token-0123456789abcdef\n', { mode: 0o600 });
const base = ['--url', 'https://gitlab.test', '--token-file', tokenFile, '--workdir', path.join(dir, 'land')];
const overrides = { projectsOverride: [{ name: 'rehearsal', path: 'vitana/rehearsal', landing: true, required_jobs: ['unit', 'build'] }], remoteUrl: () => remote };
const now = () => Date.parse('2026-11-05T10:30:00Z');

for (const [, argv] of [['status', ['status']], ['run --dry-run', ['run', '--dry-run']], ['run', ['run']]]) {
  const mark = f.mark();
  console.log(`\n$ node scripts/eng/gitlab-land.mjs ${argv.join(' ')}   (token file and workdir omitted)`);
  const out = [];
  const code = await main([...argv, ...base], { fetch: f, now, stdout: (t) => out.push(t), overrides });
  process.stdout.write(out.join(''));
  const writes = f.writes(mark).map((c) => `${c.method} ${c.path.replace('/api/v4/projects/vitana%2Frehearsal', '')}`);
  console.log(`exit ${code}; writes to GitLab: ${writes.length ? writes.join(', ') : 'none'}; merged so far: ${[...merged].join(',') || 'none'}`);
}
